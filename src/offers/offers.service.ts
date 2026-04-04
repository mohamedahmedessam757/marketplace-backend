import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOfferDto } from './dto/create-offer.dto';
import { StoresService } from '../stores/stores.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class OffersService {
    constructor(
        private prisma: PrismaService,
        private storesService: StoresService,
        private notificationsService: NotificationsService,
    ) { }

    async create(userId: string, createOfferDto: CreateOfferDto) {
        // 1. Get Vendor's Store
        const store = await this.storesService.findMyStore(userId);
        if (!store) {
            throw new NotFoundException('You need a Store to submit offers.');
        }

        // 1.5 GUARD: Extreme Validation Check
        const orderInfo = await this.prisma.order.findUnique({
            where: { id: createOfferDto.orderId },
            select: { id: true, status: true, createdAt: true, customerId: true, orderNumber: true }
        });

        if (!orderInfo) {
            throw new NotFoundException('Order not found');
        }

        if (orderInfo.status !== 'AWAITING_OFFERS') {
            throw new BadRequestException('Bidding is closed for this order. Status is no longer AWAITING_OFFERS.');
        }

        const now = new Date().getTime();
        const createdTime = new Date(orderInfo.createdAt).getTime();
        const diffHours = (now - createdTime) / (1000 * 60 * 60);

        if (diffHours >= 24) {
            throw new BadRequestException('Bidding time (24h) has strictly expired for this order.');
        }

        // 2. Validate max 10 offers per part (if part-level offer)
        if (createOfferDto.orderPartId) {
            try {
                const existingPartOffers = await this.prisma.offer.count({
                    where: { orderPartId: createOfferDto.orderPartId }
                });
                if (existingPartOffers >= 10) {
                    throw new BadRequestException('Maximum 10 offers per part reached.');
                }
            } catch (e) {
                if (e instanceof BadRequestException) throw e;
                // If order_part_id column doesn't exist yet, skip validation
                console.warn('orderPartId validation skipped (column may not exist yet):', e?.message || e);
            }
        }

        // 2.5 Generate unique offerNumber
        let offerNumber = '';
        let isOfferUnique = false;
        while (!isOfferUnique) {
            offerNumber = 'OFR-' + String(Math.floor(10000000 + Math.random() * 90000000));
            const existing = await this.prisma.offer.findUnique({ where: { offerNumber } });
            if (!existing) isOfferUnique = true;
        }

        // 3. Build offer data (conditionally include orderPartId)
        const offerData: any = {
            offerNumber,
            orderId: createOfferDto.orderId,
            storeId: store.id,
            unitPrice: createOfferDto.unitPrice,
            weightKg: createOfferDto.weightKg,
            hasWarranty: createOfferDto.hasWarranty,
            warrantyDuration: createOfferDto.warrantyDuration,
            deliveryDays: createOfferDto.deliveryDays,
            condition: createOfferDto.condition,
            partType: createOfferDto.partType,
            notes: createOfferDto.notes,
            offerImage: createOfferDto.offerImage,
            shippingCost: createOfferDto.shippingCost ?? 0,
        };

        // Only include orderPartId if provided (avoids DB error if column doesn't exist yet)
        if (createOfferDto.orderPartId) {
            offerData.orderPartId = createOfferDto.orderPartId;
        }

        // 4. Create Offer
        let offer;
        try {
            offer = await this.prisma.offer.create({
                data: offerData,
                include: {
                    store: { select: { name: true, storeCode: true } },
                }
            });
        } catch (prismaError: any) {
            // If orderPartId column doesn't exist, retry without it
            if (prismaError?.code === 'P2009' || prismaError?.message?.includes('order_part_id')) {
                delete offerData.orderPartId;
                offer = await this.prisma.offer.create({
                    data: offerData,
                    include: {
                        store: { select: { name: true, storeCode: true } },
                    }
                });
            } else {
                throw prismaError;
            }
        }

        // 5. Update Order Status to AWAITING_OFFERS (if not already)
        // Actually, status logic might be handled by OrdersService, but here we just ensure flow.

        // 6. Notify Customer (Fire and Forget)
        if (orderInfo && orderInfo.customerId) {
            this.notificationsService.create({
                recipientId: orderInfo.customerId,
                recipientRole: 'CUSTOMER',
                titleAr: 'عرض سعر جديد!',
                titleEn: 'New Offer Received!',
                messageAr: `قام متجر "${store.name}" بتقديم عرض جديد لطلبك رقم ${orderInfo.orderNumber}`,
                messageEn: `Store "${store.name}" submitted a new offer for your order #${orderInfo.orderNumber}`,
                type: 'OFFER',
                link: `/dashboard/orders/${orderInfo.id}`
            }).catch(e => console.error('Failed to notify customer of new offer', e));
        }

        return offer;
    }

    async findByOrder(orderId: string) {
        return this.prisma.offer.findMany({
            where: { orderId },
            include: {
                store: {
                    select: {
                        id: true,
                        name: true,
                        storeCode: true,
                        rating: true,
                        createdAt: true,
                        _count: { select: { orders: true } }
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });
    }

    /**
     * Returns only the current merchant's offers for a specific order.
     */
    async findMyOffersByOrder(userId: string, orderId: string) {
        const store = await this.storesService.findMyStore(userId);
        if (!store) return [];

        return this.prisma.offer.findMany({
            where: { orderId, storeId: store.id },
            include: {
                store: { select: { id: true, name: true, storeCode: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
    }

    /**
     * Update an existing offer — only the offer owner can update.
     */
    async update(userId: string, offerId: string, updateDto: any) {
        const store = await this.storesService.findMyStore(userId);
        if (!store) {
            throw new NotFoundException('Store not found.');
        }

        // Find the offer and verify ownership
        const existing = await this.prisma.offer.findUnique({
            where: { id: offerId },
            select: { id: true, storeId: true, orderId: true }
        });

        if (!existing) {
            throw new NotFoundException('Offer not found.');
        }

        if (existing.storeId !== store.id) {
            throw new BadRequestException('You can only edit your own offers.');
        }

        // Verify order is still open for bidding
        const order = await this.prisma.order.findUnique({
            where: { id: existing.orderId },
            select: { status: true, createdAt: true }
        });

        if (!order || order.status !== 'AWAITING_OFFERS') {
            throw new BadRequestException('Cannot edit offer — bidding is closed.');
        }

        const now = new Date().getTime();
        const createdTime = new Date(order.createdAt).getTime();
        if ((now - createdTime) / (1000 * 60 * 60) >= 24) {
            throw new BadRequestException('Cannot edit offer — 24h bidding window expired.');
        }

        // Build update data — only include fields that were provided
        const data: any = {};
        if (updateDto.unitPrice !== undefined) data.unitPrice = updateDto.unitPrice;
        if (updateDto.weightKg !== undefined) data.weightKg = updateDto.weightKg;
        if (updateDto.shippingCost !== undefined) data.shippingCost = updateDto.shippingCost;
        if (updateDto.hasWarranty !== undefined) data.hasWarranty = updateDto.hasWarranty;
        if (updateDto.warrantyDuration !== undefined) data.warrantyDuration = updateDto.warrantyDuration;
        if (updateDto.deliveryDays !== undefined) data.deliveryDays = updateDto.deliveryDays;
        if (updateDto.condition !== undefined) data.condition = updateDto.condition;
        if (updateDto.partType !== undefined) data.partType = updateDto.partType;
        if (updateDto.notes !== undefined) data.notes = updateDto.notes;
        if (updateDto.offerImage !== undefined) data.offerImage = updateDto.offerImage;
        data.updatedAt = new Date();

        return this.prisma.offer.update({
            where: { id: offerId },
            data,
            include: {
                store: { select: { id: true, name: true } }
            }
        });
    }

    /**
     * Cancel an offer by the vendor who created it.
     */
    async cancelByVendor(userId: string, offerId: string) {
        const store = await this.storesService.findMyStore(userId);
        if (!store) {
            throw new NotFoundException('Store not found.');
        }

        const existing = await this.prisma.offer.findUnique({
            where: { id: offerId },
            include: {
                order: { select: { id: true, status: true, customerId: true, orderNumber: true } }
            }
        });

        if (!existing) {
            throw new NotFoundException('Offer not found.');
        }

        if (existing.storeId !== store.id) {
            throw new BadRequestException('You can only cancel your own offers.');
        }

        if (!existing.order || existing.order.status !== 'AWAITING_OFFERS') {
            throw new BadRequestException('Cannot cancel offer — bidding is closed or order has progressed.');
        }

        await this.prisma.offer.delete({ where: { id: offerId } });

        // Notify Customer (Optional but good UX)
        if (existing.order?.customerId) {
            this.notificationsService.create({
                recipientId: existing.order.customerId,
                recipientRole: 'CUSTOMER',
                titleAr: 'تم سحب عرض سعر',
                titleEn: 'Offer Retracted',
                messageAr: `قام أحد المتاجر بسحب عرضه لطلبك رقم ${existing.order?.orderNumber}`,
                messageEn: `A store has retracted their offer for your order #${existing.order?.orderNumber}`,
                type: 'SYSTEM',
                link: `/dashboard/orders/${existing.order?.id}`
            }).catch(e => console.error('Failed to notify customer of offer retraction', e));
        }

        return { message: 'Offer cancelled successfully by vendor' };
    }

    /**
     * Admin Update: Allows an administrator to update ANY offer regardless of ownership or order status.
     * Also sends a notification to the merchant.
     */
    async adminUpdate(adminId: string, offerId: string, updateDto: any) {
        const existing = await this.prisma.offer.findUnique({
            where: { id: offerId },
            include: {
                store: { select: { id: true, name: true, ownerId: true } },
                order: { select: { id: true, orderNumber: true, customerId: true } }
            }
        });

        if (!existing) {
            throw new NotFoundException('Offer not found.');
        }

        // Cast after null-guard — the include clause already fetched store + order
        const offer = existing as any;

        // Build data
        const data: any = { ...updateDto, updatedAt: new Date() };

        const updated = await this.prisma.offer.update({
            where: { id: offerId },
            data,
            include: {
                store: { select: { name: true } }
            }
        });

        // Notify Merchant
        if (offer.store?.userId) {
            await this.notificationsService.create({
                recipientId: offer.store.userId,
                recipientRole: 'VENDOR',
                titleAr: 'تعديل إداري على عرضك',
                titleEn: 'Admin Update on Your Offer',
                messageAr: `قام المسؤول بتعديل تفاصيل عرضك رقم ${offer.offerNumber} للطلب #${offer.order?.orderNumber}`,
                messageEn: `An administrator updated your offer #${offer.offerNumber} for order #${offer.order?.orderNumber}`,
                type: 'OFFER',
                link: `/dashboard/merchant/orders/${offer.order?.id}`
            }).catch(e => console.error('Failed to notify merchant of admin update', e));
        }

        return updated;
    }

    /**
     * Admin Delete: Allows an administrator to delete ANY offer.
     * Sends notifications to both merchant and customer.
     */
    async adminDelete(adminId: string, offerId: string) {
        const existing = await this.prisma.offer.findUnique({
            where: { id: offerId },
            include: {
                store: { select: { id: true, name: true, ownerId: true } },
                order: { select: { id: true, orderNumber: true, customerId: true } }
            }
        });

        if (!existing) {
            throw new NotFoundException('Offer not found.');
        }

        // Cast after null-guard — the include clause already fetched store + order
        const offer = existing as any;

        await this.prisma.offer.delete({ where: { id: offerId } });

        // Notify Merchant
        if (offer.store?.userId) {
            await this.notificationsService.create({
                recipientId: offer.store.userId,
                recipientRole: 'VENDOR',
                titleAr: 'تم حذف عرضك من قبل الإدارة',
                titleEn: 'Offer Deleted by Admin',
                messageAr: `قام المسؤول بحذف عرضك رقم ${offer.offerNumber} للطلب #${offer.order?.orderNumber}`,
                messageEn: `An administrator deleted your offer #${offer.offerNumber} for order #${offer.order?.orderNumber}`,
                type: 'OFFER',
                link: `/dashboard/merchant/orders`
            }).catch(e => console.error('Failed to notify merchant of admin delete', e));
        }

        // Notify Customer
        if (offer.order?.customerId) {
            await this.notificationsService.create({
                recipientId: offer.order.customerId,
                recipientRole: 'CUSTOMER',
                titleAr: 'تحديث بخصوص عرض ملغي',
                titleEn: 'Update Regarding a Cancelled Offer',
                messageAr: `تمت إزالة أحد العروض المقدمة لطلبك رقم ${offer.order.orderNumber} من قبل الإدارة لمخالفته المعايير.`,
                messageEn: `One of the offers for your order #${offer.order.orderNumber} was removed by administration for non-compliance.`,
                type: 'SYSTEM',
                link: `/dashboard/orders/${offer.order.id}`
            }).catch(e => console.error('Failed to notify customer of admin delete', e));
        }

        return { message: 'Offer deleted successfully by admin' };
    }
}

