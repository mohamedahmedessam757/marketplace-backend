import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ShipmentsService } from '../shipments/shipments.service';
import { ActorType, OrderStatus } from '@prisma/client';

@Injectable()
export class WaybillsService {
    private readonly logger = new Logger(WaybillsService.name);

    constructor(
        private prisma: PrismaService,
        private notifications: NotificationsService,
        private auditLogs: AuditLogsService,
        private shipments: ShipmentsService,
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

        const isReturn = order.status === OrderStatus.RETURN_APPROVED;
        const allowedStatuses = [OrderStatus.VERIFICATION_SUCCESS, OrderStatus.READY_FOR_SHIPPING, OrderStatus.RETURN_APPROVED];
        
        if (!allowedStatuses.includes(order.status)) {
            throw new BadRequestException(`Order status must be ${allowedStatuses.join(' or ')} to issue waybills.`);
        }

        const waybillsList = (order as any).shippingWaybills || [];
        // Only block if NOT a return and waybills already exist
        if (!isReturn && waybillsList.length > 0) {
            throw new BadRequestException('Waybills have already been issued for this order.');
        }

        const issuedWaybills: any[] = [];
        const year = new Date().getFullYear();
        const parts = (order as any).parts || [];

        if (parts.length === 0) {
            throw new BadRequestException('Order has no parts to issue waybills for.');
        }

        const shippingAddr = (order as any).shippingAddresses?.[0] || null;
        
        // Sender/Recipient logic (Swapped for Returns)
        // Original: Store -> Customer
        // Return: Customer -> Store
        
        const customerName = shippingAddr?.fullName || shippingAddr?.full_name || order.customer.name || 'Customer';
        const customerPhone = shippingAddr?.phone || order.customer.phone || '';
        const customerAddress = shippingAddr?.details || 'Order Address';
        const customerCity = shippingAddr?.city || (order.customer as any)?.country || '';
        const customerCountry = shippingAddr?.country || (order.customer as any)?.country || '';

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
            const waybillNumber = isReturn ? `RTN-${year}-${randomSuffix}` : `WB-${year}-${randomSuffix}`;

            const waybillData = {
                waybillNumber,
                orderId: order.id,
                partId: part.id,
                storeId: acceptedOffer.store.id,
                storeName: isReturn ? customerName : acceptedOffer.store.name,
                storeCode: isReturn ? (order.customer.id.substring(0, 8).toUpperCase()) : (acceptedOffer.store.storeCode || ''),
                recipientName: isReturn ? acceptedOffer.store.name : customerName,
                recipientPhone: isReturn ? (acceptedOffer.store as any).phone : customerPhone,
                recipientEmail: isReturn ? (acceptedOffer.store as any).email : (shippingAddr?.email || order.customer.email),
                recipientCity: isReturn ? 'Platform Hub' : customerCity,
                recipientCountry: isReturn ? 'UAE' : customerCountry,
                recipientAddress: isReturn ? 'Return Center' : customerAddress,
                customerCode: isReturn ? (acceptedOffer.store.storeCode || 'VNDR') : order.customer.id.substring(0, 8).toUpperCase(),
                partName: part.name,
                partDescription: isReturn ? `RETURN: ${part.description}` : part.description,
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
                        titleAr: isReturn ? 'إصدار بوليصة إرجاع 🔄' : 'تم إصدار بوليصة الشحن',
                        titleEn: isReturn ? 'Return Label Issued 🔄' : 'Shipping Waybill Issued',
                        messageAr: isReturn 
                            ? `تم إصدار بوليصة إرجاع للطلب #${order.orderNumber}. يرجى ترقب وصول المرتجع للمستودع.`
                            : `قامت الإدارة بإصدار بوليصة لطلبك الموثق #${order.orderNumber}. بانتظار استلام المندوب.`,
                        messageEn: isReturn
                            ? `Return label issued for order #${order.orderNumber}. Please await the return shipment.`
                            : `Admin issued waybill for your verified order #${order.orderNumber}. Pending courier pickup.`,
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
                titleAr: isReturn ? 'بوليصة الإرجاع جاهزة! 📑' : 'تم إصدار بوليصة الشحن بنجاح! 📑',
                titleEn: isReturn ? 'Return Label Ready! 📑' : 'Shipping Waybill Ready! 📑',
                messageAr: isReturn
                    ? `تم إصدار بوليصة الإرجاع للطلب #${order.orderNumber}. يرجى تسليم القطعة للمندوب عند وصوله.`
                    : `خبر سار! تم إصدار بوليصة الشحن لطلبك #${order.orderNumber}. طلبك الآن في مرحلة التجهيز النهائي للتسليم.`,
                messageEn: isReturn
                    ? `Return label for order #${order.orderNumber} is ready. Please hand over the part to the courier when they arrive.`
                    : `Great news! Your shipping waybill for #${order.orderNumber} is ready. Your order is now in final preparation for delivery.`,
                link: `/customer/orders/${order.id}`
            } as any);
        } catch (e) {
            this.logger.error('Failed to notify customer waybill issuance', e);
        }

        // Phase 2: Automatic Shipment Tracker Initialization (2026 Logic)
        try {
            // Check if a shipment already exists for this order
            const existingShipment = await this.prisma.shipment.findFirst({
                where: { orderId: order.id }
            });

            if (!existingShipment) {
                // Initialize the shipment record to provide a source of truth for the Detailed Journey tracker
                await this.shipments.create({
                    orderId: order.id,
                    waybillId: issuedWaybills[0]?.id, // Link to the first waybill
                    carrierType: 'NO_TRACKING',
                }, adminId);
                
                this.logger.log(`Initialized shipment tracker for order ${order.orderNumber}`);
            }
        } catch (shipmentErr) {
            this.logger.error('Failed to auto-initialize shipment tracker', shipmentErr.message);
        }

        // Phase 2: Administrative Audit Logging
        await this.auditLogs.logAction({
            orderId,
            action: 'WAYBILL_ISSUAL',
            entity: 'Order',
            actorType: ActorType.ADMIN,
            actorId: adminId,
            actorName: 'Admin',
            previousState: order.status,
            newState: order.status,
            reason: 'Administrative issuance of shipping waybills for verified parts.',
            metadata: {
                waybillCount: issuedWaybills.length,
                waybillNumbers: issuedWaybills.map(wb => wb.waybillNumber),
                timestamp: new Date().toISOString()
            }
        });

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
