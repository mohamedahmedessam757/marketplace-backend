import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOfferDto } from './dto/create-offer.dto';
import { StoresService } from '../stores/stores.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ActorType, OrderStatus } from '@prisma/client';

@Injectable()
export class OffersService {
    constructor(
        private prisma: PrismaService,
        private storesService: StoresService,
        private notificationsService: NotificationsService,
        private auditLogs: AuditLogsService,
    ) { }

    async create(userId: string, createOfferDto: CreateOfferDto) {
        // 1. Get Vendor's Store
        const store = await this.storesService.findMyStore(userId);
        if (!store) {
            throw new NotFoundException('You need a Store to submit offers.');
        }

        // --- 2026 Governance Enforcement: Offer Limit ---
        // Fetch the latest count and limit from DB to ensure accuracy
        const storeCheck = await this.prisma.store.findUnique({
            where: { id: store.id },
            select: { offerLimit: true, dailyOfferCount: true }
        });

        if (storeCheck && storeCheck.offerLimit !== -1 && storeCheck.dailyOfferCount >= storeCheck.offerLimit) {
            throw new ForbiddenException(`You have reached your daily limit of ${storeCheck.offerLimit} offers. Please try again tomorrow.`);
        }
        // ------------------------------------------------

        // 1.5 GUARD: Extreme Validation Check
        const orderInfo = await this.prisma.order.findUnique({
            where: { id: createOfferDto.orderId },
            select: { id: true, status: true, createdAt: true, customerId: true, orderNumber: true, offersStopAt: true }
        });

        if (!orderInfo) {
            throw new NotFoundException('Order not found');
        }

        if (orderInfo.status !== OrderStatus.COLLECTING_OFFERS && orderInfo.status !== OrderStatus.AWAITING_OFFERS) {
            throw new BadRequestException(`Bidding is closed. Order status is ${orderInfo.status}.`);
        }
        
        const now = new Date();
        if (orderInfo.offersStopAt && now > orderInfo.offersStopAt) {
            throw new BadRequestException('Bidding time has strictly expired for this order (reveal phase approaching).');
        }

        // --- 2026 Governance: Check if merchant already has a withdrawn offer for this order ---
        const previousWithdrawn = await this.prisma.offer.findFirst({
            where: { orderId: orderInfo.id, storeId: store.id, isWithdrawn: true }
        });
        if (previousWithdrawn) {
            throw new BadRequestException('You have previously withdrawn an offer for this order and cannot submit another one.');
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
            cylinders: createOfferDto.cylinders,
            shippingCost: createOfferDto.shippingCost ?? 0,
            canEditUntil: new Date(Date.now() + 15 * 60 * 1000), // 15 Minute window
        };

        // Only include orderPartId if provided (avoids DB error if column doesn't exist yet)
        if (createOfferDto.orderPartId) {
            offerData.orderPartId = createOfferDto.orderPartId;
        }

        // 4. Create Offer & Update Daily Count
        let offer;
        try {
            offer = await this.prisma.$transaction(async (tx) => {
                // Increment daily count and total governance count
                await tx.store.update({
                    where: { id: store.id },
                    data: { 
                        dailyOfferCount: { increment: 1 },
                        totalOffersSent: { increment: 1 }
                    }
                });

                return await tx.offer.create({
                    data: offerData,
                    include: {
                        store: { select: { name: true, storeCode: true } },
                    }
                });
            });
        } catch (prismaError: any) {
            // If orderPartId column doesn't exist, retry without it
            if (prismaError?.code === 'P2009' || prismaError?.message?.includes('order_part_id')) {
                delete offerData.orderPartId;
                offer = await this.prisma.$transaction(async (tx) => {
                    await tx.store.update({
                        where: { id: store.id },
                        data: { 
                            dailyOfferCount: { increment: 1 },
                            totalOffersSent: { increment: 1 }
                        }
                    });
                    return await tx.offer.create({
                        data: offerData,
                        include: {
                            store: { select: { name: true, storeCode: true } },
                        }
                    });
                });
            } else {
                throw prismaError;
            }
        }
        
        // 5. Audit Log (2026 Observability)
        await this.auditLogs.logAction({
            orderId: createOfferDto.orderId,
            action: 'CREATE_OFFER',
            entity: 'Offer',
            actorType: ActorType.VENDOR,
            actorId: userId,
            actorName: store.name,
            newState: 'pending',
            metadata: { 
                offerId: offer.id, 
                offerNumber: offer.offerNumber, 
                unitPrice: offer.unitPrice,
                shippingCost: offer.shippingCost
            }
        });

        // 6. Update Order Status to AWAITING_OFFERS (if not already)
        // Actually, status logic might be handled by OrdersService, but here we just ensure flow.

        // 6. Notify Customer (SUPPRESSED FOR 2026)
        if (orderInfo && orderInfo.customerId) {
            // Suppressed for 2026 Blind Auction
            console.log('Customer notification suppressed for Blind Auction phase');

            // 7. Notify Admin about New Offer (Marketplace Oversight)
            this.notificationsService.notifyAdmins({
                titleAr: 'عرض سعر جديد في المنصة',
                titleEn: 'New Marketplace Offer',
                messageAr: `قام متجر "${store.name}" بتقديم عرض للطلب #${orderInfo.orderNumber}`,
                messageEn: `Store "${store.name}" submitted an offer for order #${orderInfo.orderNumber}`,
                type: 'OFFER',
                link: `/admin/orders/${orderInfo.id}`,
                metadata: { orderId: orderInfo.id, offerId: offer.id }
            }).catch(() => {});

            // 8. Notify Merchant about their 15-minute edit window (Governance Info)
            this.notificationsService.create({
                recipientId: userId,
                recipientRole: 'VENDOR',
                titleAr: 'تم إرسال عرضك بنجاح ✅',
                titleEn: 'Offer Submitted Successfully ✅',
                messageAr: 'لديك 15 دقيقة للتعديل على العرض بحرية. بعد ذلك، سيتم قفل العرض ولن تتمكن إلا من سحبه نهائياً مع تسجيل مخالفة.',
                messageEn: 'You have a 15-minute window to edit your offer freely. After that, it will be locked and you can only withdraw it (counts as a violation).',
                type: 'system_alert',
                link: `/dashboard/merchant/orders/${orderInfo.id}`
            }).catch(() => {});
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
                        _count: { select: { orders: true, reviews: true } }
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
            where: { 
                orderId, 
                storeId: store.id,
                isWithdrawn: false // Exclude withdrawn offers from active view
            },
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
            select: { id: true, storeId: true, orderId: true, canEditUntil: true, isWithdrawn: true }
        });

        if (!existing) {
            throw new NotFoundException('Offer not found.');
        }

        if (existing.storeId !== store.id) {
            throw new BadRequestException('You can only edit your own offers.');
        }

        if (existing.isWithdrawn) {
            throw new BadRequestException('This offer has been withdrawn and cannot be edited.');
        }

        // Verify order is still open for bidding
        const order = await this.prisma.order.findUnique({
            where: { id: existing.orderId },
            select: { status: true, createdAt: true, offersStopAt: true }
        });

        if (!order || (order.status !== OrderStatus.COLLECTING_OFFERS && order.status !== OrderStatus.AWAITING_OFFERS)) {
            throw new BadRequestException('Cannot edit offer — bidding is closed.');
        }

        const now = new Date();
        if (existing.canEditUntil && now > existing.canEditUntil) {
            throw new BadRequestException('The 15-minute edit window for this offer has expired. You can only withdraw it now.');
        }

        if (order.offersStopAt && now > order.offersStopAt) {
            throw new BadRequestException('Cannot edit offer — 24h bidding phase is ending.');
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
        if (updateDto.cylinders !== undefined) data.cylinders = updateDto.cylinders;
        data.updatedAt = new Date();

        const updated = await this.prisma.$transaction(async (tx) => {
            // Increment edit count for governance tracking
            await tx.store.update({
                where: { id: store.id },
                data: { editCount: { increment: 1 } }
            });

            return await tx.offer.update({
                where: { id: offerId },
                data,
                include: {
                    store: { select: { id: true, name: true, ownerId: true } }
                }
            });
        });

        // --- 2026 Governance: Threshold Check ---
        this.checkGovernanceThresholds(store.id, updated.store?.name || 'Vendor', updated.store?.ownerId).catch(() => {});
        // ----------------------------------------

        // Audit Log (2026 Change Tracking)
        await this.auditLogs.logAction({
            orderId: existing.orderId,
            action: 'UPDATE_OFFER',
            entity: 'Offer',
            actorType: ActorType.VENDOR,
            actorId: userId,
            actorName: updated.store?.name || 'Vendor',
            previousState: JSON.stringify(existing),
            newState: JSON.stringify(updated),
            metadata: { offerId, changes: data }
        });

        return updated;
    }

    /**
     * Permanent Withdrawal of an offer (Marketplace Governance 2026)
     */
    async withdraw(userId: string, offerId: string) {
        const store = await this.storesService.findMyStore(userId);
        if (!store) throw new NotFoundException('Store not found.');

        const existing = await this.prisma.offer.findUnique({
            where: { id: offerId },
            select: { id: true, storeId: true, orderId: true, isWithdrawn: true }
        });

        if (!existing) throw new NotFoundException('Offer not found.');
        if (existing.storeId !== store.id) throw new ForbiddenException('Not your offer.');
        if (existing.isWithdrawn) throw new BadRequestException('Already withdrawn.');

        const result = await this.prisma.$transaction(async (tx) => {
            await tx.store.update({
                where: { id: store.id },
                data: { withdrawalCount: { increment: 1 } }
            });

            return await tx.offer.update({
                where: { id: offerId },
                data: { 
                    status: 'withdrawn',
                    isWithdrawn: true,
                    updatedAt: new Date()
                },
                include: { store: { select: { id: true, name: true, ownerId: true } } }
            });
        });

        // --- 2026 Governance: Threshold Check ---
        this.checkGovernanceThresholds(store.id, result.store?.name || 'Vendor', result.store?.ownerId).catch(() => {});
        // ----------------------------------------

        await this.auditLogs.logAction({
            orderId: existing.orderId,
            action: 'WITHDRAW_OFFER',
            entity: 'Offer',
            actorType: ActorType.VENDOR,
            actorId: userId,
            actorName: result.store?.name || 'Vendor',
            newState: 'withdrawn',
            metadata: { offerId }
        });

        return result;
    }

    /**
     * Legacy cancel method (adapted to use withdraw if appropriate)
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

        if (!existing.order || (existing.order.status !== OrderStatus.COLLECTING_OFFERS && existing.order.status !== OrderStatus.AWAITING_OFFERS)) {
            throw new BadRequestException('Cannot cancel offer — bidding is closed or order has progressed.');
        }

        // --- 2026 Governance Rule: Free Cancel only within 15m ---
        const canEditUntil = existing.canEditUntil ? new Date(existing.canEditUntil) : null;
        if (!canEditUntil || new Date() > canEditUntil) {
            throw new BadRequestException('Free edit window has expired. You must use the "Withdraw" process (counts as violation).');
        }
        // ------------------------------------------------------

        // Audit Log (2026 Cancellation Tracking)
        await this.auditLogs.logAction({
            orderId: existing.orderId,
            action: 'CANCEL_OFFER_VENDOR',
            entity: 'Offer',
            actorType: ActorType.VENDOR,
            actorId: userId,
            actorName: store.name,
            previousState: JSON.stringify(existing),
            newState: 'DELETED',
            reason: 'Vendor retracted their offer during bidding window'
        });

        await this.prisma.offer.delete({ where: { id: offerId } });

        // Notify Customer (Suppressed for 2026 Blind Auction)
        const isBlindAuction = ['COLLECTING_OFFERS', 'AWAITING_OFFERS'].includes(existing.order?.status || '');
        if (existing.order?.customerId && !isBlindAuction) {
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

        // Audit Log (2026 Admin Oversight)
        await this.auditLogs.logAction({
            orderId: offer.order?.id || offer.orderId,
            action: 'ADMIN_UPDATE_OFFER',
            entity: 'Offer',
            actorType: ActorType.ADMIN,
            actorId: adminId,
            actorName: 'Administrator',
            previousState: JSON.stringify(existing),
            newState: JSON.stringify(updated),
            metadata: { offerId, changes: data }
        });

        // Notify Merchant
        if (offer.store?.ownerId) {
            await this.notificationsService.create({
                recipientId: offer.store.ownerId,
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

        // Audit Log (2026 Admin Intervention)
        await this.auditLogs.logAction({
            orderId: offer.order?.id || offer.orderId,
            action: 'ADMIN_DELETE_OFFER',
            entity: 'Offer',
            actorType: ActorType.ADMIN,
            actorId: adminId,
            actorName: 'Administrator',
            previousState: JSON.stringify(existing),
            newState: 'DELETED',
            reason: 'Administrative removal of offer'
        });

        await this.prisma.offer.delete({ where: { id: offerId } });

        // Notify Merchant
        if (offer.store?.ownerId) {
            await this.notificationsService.create({
                recipientId: offer.store.ownerId,
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

    /**
     * Internal 2026 Governance logic: Monitors store modification/withdrawal rates.
     * Triggers admin alerts and merchant warnings if rate > 5%.
     */
    private async checkGovernanceThresholds(storeId: string, storeName: string, ownerId?: string) {
        try {
            const store = await this.prisma.store.findUnique({
                where: { id: storeId },
                select: { totalOffersSent: true, editCount: true, withdrawalCount: true }
            });

            if (!store || store.totalOffersSent < 20) return; // Minimum sample size of 20 to avoid early noise

            const modificationRate = (store.editCount + store.withdrawalCount) / store.totalOffersSent;

            if (modificationRate > 0.05) {
                // 1. Notify Admins about potential governance abuse
                await this.notificationsService.notifyAdmins({
                    titleAr: 'تنبيه حوكمة: تجاوز حد التعديلات ⚠️',
                    titleEn: 'Governance Alert: Modification Threshold Exceeded ⚠️',
                    messageAr: `المتجر "${storeName}" تجاوز نسبة 5% في تعديل أو سحب العروض (النسبة الحالية: ${(modificationRate * 100).toFixed(1)}%). يرجى مراجعة نشاط المتجر.`,
                    messageEn: `Store "${storeName}" has exceeded the 5% threshold for offer modifications/withdrawals (Current rate: ${(modificationRate * 100).toFixed(1)}%). Please review store activity.`,
                    type: 'GOVERNANCE_ALERT',
                    metadata: { storeId, modificationRate, totalOffers: store.totalOffersSent }
                });

                // 2. Notify Merchant as a formal warning
                if (ownerId) {
                    await this.notificationsService.create({
                        recipientId: ownerId,
                        recipientRole: 'VENDOR',
                        titleAr: 'تحذير حوكمة: تجاوز سقف التعديلات المسموح ⚠️',
                        titleEn: 'Governance Warning: Modification Threshold Reached ⚠️',
                        messageAr: `لقد تجاوزت نسبة 5% في تعديل أو سحب العروض. تكرار هذا النمط قد يؤدي لتقييد ظهور عروضك أو تعليق الحساب لمراجعة الجودة.`,
                        messageEn: `You have reached the 5% threshold for offer modifications/withdrawals. Repeating this pattern may lead to visibility restrictions or account suspension for quality review.`,
                        type: 'ALERT',
                        link: '/dashboard/merchant/profile'
                    });
                }
            }
        } catch (error) {
            console.error('Governance threshold check failed:', error);
        }
    }
}

