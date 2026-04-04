import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class WaybillsService {
    private readonly logger = new Logger(WaybillsService.name);

    constructor(
        private prisma: PrismaService,
        private notifications: NotificationsService
    ) {}

    /**
     * Issue Waybills for an order.
     * Admin only. The order MUST be in VERIFICATION_SUCCESS status.
     * Creates one waybill per order part.
     */
    async issueWaybillsForOrder(orderId: string, adminId: string) {
        // Fetch order with all needed relations
        const order = await (this.prisma.order as any).findUnique({
            where: { id: orderId } as any,
            include: {
                customer: true,
                store: true,
                parts: {
                    include: {
                        offers: {
                            where: { status: 'accepted' },
                            include: { store: true }
                        }
                    }
                },
                shippingAddresses: true,
                invoices: true,
                shippingWaybills: true
            } as any
        } as any);

        if (!order) {
            throw new NotFoundException('Order not found');
        }

        if (order.status !== 'VERIFICATION_SUCCESS') {
            throw new BadRequestException('Order verification is not successful yet. Cannot issue waybills.');
        }

        const waybillsList = (order as any).shippingWaybills || [];
        if (waybillsList.length > 0) {
            throw new BadRequestException('Waybills have already been issued for this order.');
        }

        const issuedWaybills: any[] = [];
        const year = new Date().getFullYear();
        const parts = (order as any).parts || [];

        if (parts.length === 0) {
            throw new BadRequestException('Order has no parts to issue waybills for.');
        }

        const shippingAddr = (order as any).shippingAddresses?.[0] || null;
        const recipientCity = shippingAddr?.city || (order.customer as any)?.country || '';
        const recipientCountry = shippingAddr?.country || (order.customer as any)?.country || '';
        const recipientAddress = shippingAddr?.details || 'Order Address';

        // Calculate final total including shipping and commission from invoice if available
        const mainInvoice = (order as any).invoices?.[0];
        const invoiceTotal = mainInvoice?.total ? Number(mainInvoice.total) : 0;

        for (const part of parts) {
            const acceptedOffer = (part as any).offers?.[0];
            if (!acceptedOffer || !acceptedOffer.store) {
                 throw new BadRequestException(`Part ${part.name || 'Unknown'} does not have an accepted offer or assigned store.`);
            }

            // Fallback to unitPrice if invoice total fails or is missing
            const fallbackPrice = acceptedOffer ? Number(acceptedOffer.unitPrice) : 0;
            const finalPrice = invoiceTotal > 0 ? invoiceTotal : fallbackPrice;

            const randomSuffix = Math.floor(10000 + Math.random() * 90000);
            const waybillNumber = `WB-${year}-${randomSuffix}`;

            const waybillData = {
                waybillNumber,
                orderId: order.id,
                partId: part.id,
                storeId: acceptedOffer.store.id,
                storeName: acceptedOffer.store.name,
                storeCode: acceptedOffer.store.storeCode || '',
                recipientName: shippingAddr?.fullName || shippingAddr?.full_name || order.customer.name || 'Customer',
                recipientPhone: shippingAddr?.phone || order.customer.phone || '',
                recipientEmail: shippingAddr?.email || order.customer.email,
                recipientCity,
                recipientCountry,
                recipientAddress,
                customerCode: order.customer.id.substring(0, 8).toUpperCase(),
                partName: part.name,
                partDescription: part.description,
                finalPrice,
                currency: 'AED',
                issuedBy: adminId
            };

            const waybill = await (this.prisma as any).shippingWaybill.create({
                data: waybillData
            });

            issuedWaybills.push(waybill);

            // Notify Merchant for this specific part's waybill
            try {
                if (acceptedOffer.store.ownerId) {
                    await this.notifications.create({
                        recipientId: acceptedOffer.store.ownerId,
                        recipientRole: 'MERCHANT',
                        type: 'order_update',
                        titleAr: 'تم إصدار بوليصة الشحن',
                        titleEn: 'Shipping Waybill Issued',
                        messageAr: `قامت الإدارة بإصدار بوليصة لطلبك الموثق #${order.orderNumber}. بانتظار استلام المندوب.`,
                        messageEn: `Admin issued waybill for your verified order #${order.orderNumber}. Pending courier pickup.`,
                        link: `/merchant/orders/${order.id}`
                    } as any);
                }
            } catch (e) {
                this.logger.error('Failed to notify merchant waybill issuance', e);
            }
        }

        // Notify Customer (once for overall order)
        try {
            await this.notifications.create({
                recipientId: order.customerId,
                recipientRole: 'CUSTOMER',
                type: 'order_update',
                titleAr: 'تم إصدار بوليصة الشحن',
                titleEn: 'Shipping Waybill Issued',
                messageAr: `تم إصدار خطة الشحن بنجاح لطلبك #${order.orderNumber}. طلبك قيد التجهيز للتوصيل.`,
                messageEn: `Shipping plan has been issued for order #${order.orderNumber}. Your order is being prepared for delivery.`,
                link: `/customer/orders/${order.id}`
            } as any);
        } catch (e) {
            this.logger.error('Failed to notify customer waybill issuance', e);
        }

        return { waybills: issuedWaybills, count: issuedWaybills.length };
    }

    /**
     * Get all waybills for a specific order
     */
    async getWaybillsByOrder(orderId: string) {
        const waybills = await (this.prisma as any).shippingWaybill.findMany({
            where: { orderId } as any,
            include: {
                issuer: {
                    select: { id: true, name: true, role: true }
                }
            } as any,
            orderBy: { createdAt: 'asc' } as any
        } as any);
        return { waybills };
    }

    /**
     * Get details of a single waybill
     */
    async getWaybillById(id: string) {
        const waybill = await (this.prisma as any).shippingWaybill.findUnique({
            where: { id } as any,
            include: {
                order: true,
                orderPart: true,
                store: true
            } as any
        } as any);

        if (!waybill) {
            throw new NotFoundException('Waybill not found');
        }
        return waybill;
    }
}
