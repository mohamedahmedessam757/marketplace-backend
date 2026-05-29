import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ShipmentsService } from '../shipments/shipments.service';
import { ActorType, OrderStatus } from '@prisma/client';

type IssueWaybillOptions = {
    automated?: boolean;
    reason?: string;
    throwIfAlreadyIssued?: boolean;
};

export type WaybillIssueTrigger =
    | 'AUTO_SINGLE'
    | 'CART_BATCH'
    | 'AUTO_7DAY'
    | 'ADMIN_MANUAL';

export type IssueOfferBatchOptions = {
    mode: 'per_part' | 'single_batch' | 'custom';
    groups?: { offerIds: string[] }[];
    shipmentId?: string;
    trigger?: WaybillIssueTrigger;
    automated?: boolean;
    reason?: string;
};

export type ShipmentBatchSummary = {
    shipmentId: string;
    waybillId: string | null;
    waybillNumber: string | null;
    offerIds: string[];
    partNames: string[];
    batchSize: number;
    shippedAt: Date | null;
    trigger: string | null;
    status: string;
};

@Injectable()
export class WaybillsService {
    private readonly logger = new Logger(WaybillsService.name);

    constructor(
        private prisma: PrismaService,
        private notifications: NotificationsService,
        private auditLogs: AuditLogsService,
        private shipments: ShipmentsService,
    ) {}

    /** Platform commission — must match payments.service and customer UI. */
    private computePlatformCommission(unitPrice: number): number {
        const percentCommission = Math.round(unitPrice * 0.25);
        return unitPrice > 0 ? Math.max(percentCommission, 100) : 0;
    }

    /**
     * Customer-facing total for an accepted offer (unit + shipping + commission).
     * Prefers recorded SUCCESS payment total when available.
     */
    private resolveCustomerOfferTotal(offer: {
        unitPrice?: unknown;
        shippingCost?: unknown;
        payments?: { status: string; totalAmount?: unknown }[];
    }): number {
        const successPayment = offer.payments?.find((p) => p.status === 'SUCCESS');
        if (successPayment?.totalAmount != null) {
            return Number(successPayment.totalAmount);
        }
        const unitPrice = Number(offer.unitPrice || 0);
        const shippingCost = Number(offer.shippingCost || 0);
        return unitPrice + shippingCost + this.computePlatformCommission(unitPrice);
    }

    /** Auto-issue only for single-part orders; grouped orders use cart / admin batch flow. */
    shouldAutoIssueOnVerification(order: {
        requestType?: string | null;
        parts?: unknown[] | null;
    }): boolean {
        if (String(order.requestType || '').toLowerCase() === 'multiple') {
            return false;
        }
        const partCount = order.parts?.length ?? 0;
        return partCount <= 1;
    }

    private platformSender() {
        return {
            name: process.env.PLATFORM_HUB_NAME || 'E-Tashleh Platform Hub',
            phone: process.env.PLATFORM_HUB_PHONE || '',
            address: process.env.PLATFORM_HUB_ADDRESS || 'Platform Logistics Center',
            city: process.env.PLATFORM_HUB_CITY || 'Dubai',
            country: process.env.PLATFORM_HUB_COUNTRY || 'UAE',
        };
    }

    private parseBundledOfferIds(raw: unknown): string[] {
        if (!raw) return [];
        if (Array.isArray(raw)) return raw.map(String);
        if (typeof raw === 'string') {
            try {
                const parsed = JSON.parse(raw);
                return Array.isArray(parsed) ? parsed.map(String) : [];
            } catch {
                return [];
            }
        }
        return [];
    }

    async getOfferIdsWithWaybills(orderId: string): Promise<Set<string>> {
        const waybills = await this.prisma.shippingWaybill.findMany({
            where: { orderId },
            select: { bundledOfferIds: true, partId: true },
        });
        const covered = new Set<string>();
        for (const wb of waybills) {
            for (const id of this.parseBundledOfferIds(wb.bundledOfferIds)) {
                covered.add(id);
            }
            if (wb.partId) {
                const offer = await this.prisma.offer.findFirst({
                    where: { orderId, orderPartId: wb.partId, status: { in: ['accepted', 'ACCEPTED'] } },
                    select: { id: true },
                });
                if (offer) covered.add(offer.id);
            }
        }
        return covered;
    }

    /**
     * Issue Waybills for an order.
     * Internal issuance flow. The order MUST be in VERIFICATION_SUCCESS / READY_FOR_SHIPPING
     * for outbound shipping, or RETURN_APPROVED for returns.
     * Creates one waybill per order part.
     */
    async issueWaybillsForOrder(orderId: string, actorId?: string | null, options: IssueWaybillOptions = {}) {
        const automated = options.automated === true;
        const throwIfAlreadyIssued = options.throwIfAlreadyIssued ?? !automated;

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
                shippingWaybills: {
                    orderBy: { createdAt: 'asc' },
                },
                returns: {
                    orderBy: { createdAt: 'desc' },
                    take: 1
                }
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
            if (throwIfAlreadyIssued) {
                throw new BadRequestException('Waybills have already been issued for this order.');
            }

            this.logger.log(`Waybills already exist for order ${order.orderNumber}; skipping duplicate automated issuance.`);
            return { waybills: waybillsList, count: waybillsList.length, alreadyIssued: true };
        }

        const issuedWaybills: any[] = [];
        const year = new Date().getFullYear();
        const parts = (order as any).parts || [];

        if (parts.length === 0) {
            throw new BadRequestException('Order has no parts to issue waybills for.');
        }

        const shippingAddr = (order as any).shippingAddresses?.[0] || null;

        const cartBatchDescriptions = await this.buildCartBatchDescriptionsMap(order.id);
        
        // Sender/Recipient logic (Swapped for Returns)
        // Original: Store -> Customer
        // Return: Customer -> Store
        
        const customerName = shippingAddr?.fullName || shippingAddr?.full_name || order.customer.name || 'Customer';
        const customerPhone = shippingAddr?.phone || order.customer.phone || '';
        const customerAddress = shippingAddr?.details || 'Order Address';
        const customerCity = shippingAddr?.city || (order.customer as any)?.country || '';
        const customerCountry = shippingAddr?.country || (order.customer as any)?.country || '';

        for (const part of parts) {
            const acceptedOffer = (part as any).offers?.[0];
            if (!acceptedOffer || !acceptedOffer.store) {
                 throw new BadRequestException(`Part ${part.name || 'Unknown'} does not have an accepted offer or assigned store.`);
            }

            const finalPrice = this.resolveCustomerOfferTotal(acceptedOffer);

            const randomSuffix = Math.floor(10000 + Math.random() * 90000);
            const waybillNumber = isReturn ? `RTN-${year}-${randomSuffix}` : `WB-${year}-${randomSuffix}`;

            const returnCase = isReturn ? (order as any).returns?.[0] : null;
            const batchDesc = acceptedOffer?.id
                ? cartBatchDescriptions.get(acceptedOffer.id)
                : null;
            const partDescriptionText =
                batchDesc ||
                (isReturn ? `RETURN: ${part.description}` : part.description);

            const waybillData = {
                waybillNumber,
                orderId: order.id,
                partId: part.id,
                storeId: acceptedOffer.store.id,
                storeName: isReturn ? customerName : acceptedOffer.store.name,
                storeCode: isReturn ? (order.customer.id.substring(0, 8).toUpperCase()) : (acceptedOffer.store.storeCode || ''),
                
                // Detailed 2026 Logistics Metadata
                senderName: isReturn ? customerName : acceptedOffer.store.name,
                senderPhone: isReturn ? customerPhone : (acceptedOffer.store as any).phone || '',
                senderAddress: isReturn ? customerAddress : (acceptedOffer.store as any).address || '',
                senderCity: isReturn ? customerCity : 'Platform Hub',
                senderCountry: isReturn ? customerCountry : 'UAE',

                recipientName: isReturn ? acceptedOffer.store.name : customerName,
                recipientPhone: isReturn ? (acceptedOffer.store as any).phone : customerPhone,
                recipientEmail: isReturn ? (acceptedOffer.store as any).email : (shippingAddr?.email || order.customer.email),
                recipientCity: isReturn ? 'Platform Hub' : customerCity,
                recipientCountry: isReturn ? 'UAE' : customerCountry,
                recipientAddress: isReturn ? 'Return Center' : customerAddress,

                customerCode: isReturn ? (acceptedOffer.store.storeCode || 'VNDR') : order.customer.id.substring(0, 8).toUpperCase(),
                partName: part.name,
                partDescription: partDescriptionText,
                finalPrice,
                shippingRefund: returnCase?.shippingRefund || null, // Round-trip cost transparency
                currency: 'AED',
                issuedBy: actorId ?? null
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
                            : automated
                                ? `أصدر النظام بوليصة شحن تلقائياً للطلب الموثق #${order.orderNumber}. بانتظار استلام المندوب.`
                                : `قامت الإدارة بإصدار بوليصة لطلبك الموثق #${order.orderNumber}. بانتظار استلام المندوب.`,
                        messageEn: isReturn
                            ? `Return label issued for order #${order.orderNumber}. Please await the return shipment.`
                            : automated
                                ? `The system automatically issued a waybill for verified order #${order.orderNumber}. Pending courier pickup.`
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
                    }, actorId ?? null);
                
                this.logger.log(`Initialized shipment tracker for order ${order.orderNumber}`);
            }
        } catch (shipmentErr) {
            this.logger.error('Failed to auto-initialize shipment tracker', shipmentErr.message);
        }

        // Phase 2: Administrative Audit Logging
        await this.auditLogs.logAction({
            orderId,
            action: automated ? 'WAYBILL_AUTO_ISSUAL' : 'WAYBILL_ISSUAL',
            entity: 'Order',
            actorType: automated ? ActorType.SYSTEM : ActorType.ADMIN,
            actorId: actorId ?? undefined,
            actorName: automated ? 'System Automation' : 'Admin',
            previousState: order.status,
            newState: order.status,
            reason: options.reason || (automated
                ? 'System automatically issued shipping waybills after successful verification.'
                : 'Administrative issuance of shipping waybills for verified parts.'),
            metadata: {
                waybillCount: issuedWaybills.length,
                waybillNumbers: issuedWaybills.map(wb => wb.waybillNumber),
                automated,
                timestamp: new Date().toISOString()
            }
        });

        return { waybills: issuedWaybills, count: issuedWaybills.length };
    }

    async autoIssueAfterVerificationSuccess(orderId: string, actorId?: string | null) {
        try {
            const order = await this.prisma.order.findUnique({
                where: { id: orderId },
                include: { parts: true },
            });
            if (!order) throw new NotFoundException('Order not found');
            if (!this.shouldAutoIssueOnVerification(order)) {
                this.logger.log(
                    `Skipping auto waybill for grouped order ${order.orderNumber}; awaiting cart shipment.`,
                );
                return { skipped: true, reason: 'grouped_order' };
            }
            return await this.issueWaybillsForOrder(orderId, actorId, {
                automated: true,
                throwIfAlreadyIssued: false,
                reason: 'Automatic waybill issuance triggered by admin-approved matching verification.',
            });
        } catch (error) {
            this.logger.error(
                `Automatic waybill issuance failed for order ${orderId}: ${error instanceof Error ? error.message : error}`,
                error instanceof Error ? error.stack : undefined,
            );
            throw error;
        }
    }

    /**
     * Issue waybill(s) for a customer/admin selected offer batch (grouped orders).
     */
    async issueWaybillsForOfferBatch(
        orderId: string,
        offerIds: string[],
        actorId: string | null,
        options: IssueOfferBatchOptions,
    ) {
        if (!offerIds.length) {
            return { waybills: [], count: 0 };
        }

        const covered = await this.getOfferIdsWithWaybills(orderId);
        const pendingIds = offerIds.filter((id) => !covered.has(id));
        if (!pendingIds.length) {
            this.logger.log(`All offers in batch already have waybills for order ${orderId}`);
            return { waybills: [], count: 0, alreadyIssued: true };
        }

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: {
                customer: true,
                shippingAddresses: true,
                invoices: { orderBy: { issuedAt: 'desc' }, take: 1 },
            },
        });
        if (!order) throw new NotFoundException('Order not found');

        const offers = await this.prisma.offer.findMany({
            where: {
                id: { in: pendingIds },
                orderId,
                status: { in: ['accepted', 'ACCEPTED'] },
            },
            include: { orderPart: true, store: true, payments: { where: { status: 'SUCCESS' } } },
        });

        if (offers.length === 0) {
            throw new BadRequestException('No valid offers found for waybill issuance.');
        }

        const isGrouped = String(order.requestType || '').toLowerCase() === 'multiple';
        const batches: string[][] =
            options.mode === 'per_part'
                ? offers.map((o) => [o.id])
                : options.mode === 'custom' && options.groups?.length
                  ? options.groups.map((g) =>
                        g.offerIds.filter((id) => offers.some((o) => o.id === id)),
                    )
                  : [offers.map((o) => o.id)];

        const issuedWaybills: any[] = [];
        const shippingAddr = order.shippingAddresses?.[0] || null;
        const customerName =
            shippingAddr?.fullName || order.customer?.name || 'Customer';
        const customerPhone = shippingAddr?.phone || order.customer?.phone || '';
        const customerAddress = shippingAddr?.details || 'Order Address';
        const customerCity = shippingAddr?.city || '';
        const customerCountry = shippingAddr?.country || 'UAE';
        const platform = this.platformSender();
        const year = new Date().getFullYear();

        for (const batchOfferIds of batches) {
            if (!batchOfferIds.length) continue;

            const batchOffers = offers.filter((o) => batchOfferIds.includes(o.id));
            const partNames = batchOffers
                .map((o) => o.orderPart?.name || order.partName)
                .filter(Boolean) as string[];
            const primary = batchOffers[0];
            if (!primary?.store) {
                throw new BadRequestException('Offer store missing for waybill issuance.');
            }

            const totalPrice = batchOffers.reduce(
                (sum, o) => sum + this.resolveCustomerOfferTotal(o),
                0,
            );
            const usePlatformSender = isGrouped && batchOffers.length >= 1;
            const randomSuffix = Math.floor(10000 + Math.random() * 90000);
            const waybillNumber = `WB-${year}-${randomSuffix}`;

            const combinedDesc =
                batchOffers.length > 1
                    ? `Assembly batch (${batchOffers.length} parts): ${partNames.join(' · ')}`
                    : partNames[0] || order.partName;

            const waybill = await this.prisma.shippingWaybill.create({
                data: {
                    waybillNumber,
                    orderId: order.id,
                    partId: primary.orderPartId,
                    storeId: primary.storeId,
                    storeName: usePlatformSender ? platform.name : primary.store.name,
                    storeCode: primary.store.storeCode || '',
                    senderName: usePlatformSender ? platform.name : primary.store.name,
                    senderPhone: usePlatformSender
                        ? platform.phone
                        : (primary.store as any).phone || '',
                    senderAddress: usePlatformSender
                        ? platform.address
                        : (primary.store as any).address || '',
                    senderCity: usePlatformSender ? platform.city : 'Platform Hub',
                    senderCountry: usePlatformSender ? platform.country : 'UAE',
                    recipientName: customerName,
                    recipientPhone: customerPhone,
                    recipientEmail: shippingAddr?.email || order.customer?.email,
                    recipientCity: customerCity,
                    recipientCountry: customerCountry,
                    recipientAddress: customerAddress,
                    customerCode: order.customerId.substring(0, 8).toUpperCase(),
                    partName:
                        batchOffers.length > 1
                            ? `Grouped shipment (${batchOffers.length} parts)`
                            : partNames[0] || 'Part',
                    partDescription: combinedDesc,
                    finalPrice: totalPrice,
                    currency: 'AED',
                    bundledOfferIds: batchOfferIds as unknown as object,
                    shipmentId: options.shipmentId ?? null,
                    issueMode: options.trigger ?? 'CART_BATCH',
                    issuedBy: actorId,
                },
            });

            issuedWaybills.push(waybill);

            if (options.shipmentId) {
                await this.prisma.shipment.update({
                    where: { id: options.shipmentId },
                    data: { waybillId: waybill.id },
                });
            }

            for (const o of batchOffers) {
                if (o.store?.ownerId) {
                    await this.notifications
                        .create({
                            recipientId: o.store.ownerId,
                            recipientRole: 'MERCHANT',
                            type: 'order_update',
                            titleAr: 'تم إصدار بوليصة الشحن',
                            titleEn: 'Shipping Waybill Issued',
                            messageAr:
                                batchOffers.length > 1
                                    ? `بوليصة مجمعة للطلب #${order.orderNumber} تشمل «${partNames.join('»، «')}».`
                                    : `تم إصدار بوليصة للطلب #${order.orderNumber}.`,
                            messageEn:
                                batchOffers.length > 1
                                    ? `Grouped waybill for #${order.orderNumber} includes: ${partNames.join(', ')}.`
                                    : `Waybill issued for order #${order.orderNumber}.`,
                            link: `/merchant/orders/${order.id}`,
                        } as any)
                        .catch(() => {});
                }
            }
        }

        if (issuedWaybills.length > 0) {
            await this.notifications
                .create({
                    recipientId: order.customerId,
                    recipientRole: 'CUSTOMER',
                    type: 'order_update',
                    titleAr: 'بوليصة الشحن جاهزة',
                    titleEn: 'Shipping Waybill Ready',
                    messageAr: `تم إصدار بوليصة شحن لطلبك #${order.orderNumber}.`,
                    messageEn: `Shipping waybill issued for order #${order.orderNumber}.`,
                    link: `/customer/orders/${order.id}`,
                } as any)
                .catch(() => {});

            await this.auditLogs.logAction({
                orderId,
                action: options.automated ? 'WAYBILL_AUTO_ISSUAL' : 'WAYBILL_ISSUAL',
                entity: 'Order',
                actorType: options.automated ? ActorType.SYSTEM : ActorType.ADMIN,
                actorId: actorId ?? undefined,
                actorName: options.automated ? 'System Automation' : 'Admin',
                previousState: order.status,
                newState: order.status,
                reason:
                    options.reason ||
                    'Waybill issued for offer batch from cart or admin.',
                metadata: {
                    offerIds: pendingIds,
                    waybillCount: issuedWaybills.length,
                    trigger: options.trigger,
                    shipmentId: options.shipmentId,
                },
            });
        }

        return { waybills: issuedWaybills, count: issuedWaybills.length };
    }

    async buildShipmentBatchesForOrder(
        orderId: string,
    ): Promise<ShipmentBatchSummary[]> {
        const shipments = await this.prisma.shipment.findMany({
            where: { orderId },
            include: {
                waybill: true,
                cartOffers: { include: { orderPart: true } },
            },
            orderBy: { createdAt: 'asc' },
        });

        return shipments
            .filter((s) => s.cartOffers.length > 0)
            .map((s) => ({
                shipmentId: s.id,
                waybillId: s.waybillId,
                waybillNumber: s.waybill?.waybillNumber ?? null,
                offerIds: s.cartOffers.map((o) => o.id),
                partNames: s.cartOffers
                    .map((o) => o.orderPart?.name)
                    .filter(Boolean) as string[],
                batchSize: s.cartOffers.length,
                shippedAt: s.cartOffers[0]?.shippedFromCartAt ?? null,
                trigger: s.waybill?.issueMode ?? null,
                status: s.status,
            }));
    }

    async adminIssueWaybills(
        orderId: string,
        adminId: string,
        dto: {
            mode: 'per_part' | 'single_batch' | 'custom';
            offerIds?: string[];
            groups?: { offerIds: string[] }[];
        },
    ) {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            select: { requestType: true },
        });
        if (!order) throw new NotFoundException('Order not found');

        let targetOfferIds = dto.offerIds ?? [];
        if (!targetOfferIds.length && dto.groups?.length) {
            targetOfferIds = dto.groups.flatMap((g) => g.offerIds);
        }
        if (!targetOfferIds.length) {
            const ready = await this.prisma.offer.findMany({
                where: {
                    orderId,
                    status: { in: ['accepted', 'ACCEPTED'] },
                    fulfillmentStatus: {
                        in: ['VERIFICATION_SUCCESS', 'READY_FOR_SHIPPING', 'SHIPPED'],
                    },
                },
                select: { id: true },
            });
            targetOfferIds = ready.map((o) => o.id);
        }

        const covered = await this.getOfferIdsWithWaybills(orderId);
        targetOfferIds = targetOfferIds.filter((id) => !covered.has(id));
        if (!targetOfferIds.length) {
            throw new BadRequestException(
                'No eligible offers without an existing waybill.',
            );
        }

        if (this.shouldAutoIssueOnVerification(order)) {
            return this.issueWaybillsForOrder(orderId, adminId, {
                automated: false,
                reason: 'Admin manual issuance for single-part order.',
            });
        }

        return this.issueWaybillsForOfferBatch(orderId, targetOfferIds, adminId, {
            mode: dto.mode,
            groups: dto.groups,
            trigger: 'ADMIN_MANUAL',
            automated: false,
            reason: 'Admin manual waybill issuance for grouped order.',
        });
    }

    /**
     * For assembly-cart batches: combine part names when multiple offers share cartShipmentId.
     */
    private async buildCartBatchDescriptionsMap(
        orderId: string,
    ): Promise<Map<string, string>> {
        const offers = await this.prisma.offer.findMany({
            where: {
                orderId,
                status: 'accepted',
                cartShipmentId: { not: null },
            },
            include: { orderPart: true },
        });
        const byShipment = new Map<string, typeof offers>();
        for (const o of offers) {
            if (!o.cartShipmentId) continue;
            const list = byShipment.get(o.cartShipmentId) || [];
            list.push(o);
            byShipment.set(o.cartShipmentId, list);
        }
        const result = new Map<string, string>();
        for (const group of byShipment.values()) {
            if (group.length < 2) continue;
            const names = group
                .map((o) => o.orderPart?.name)
                .filter(Boolean) as string[];
            const combined = `Assembly batch (${group.length} parts): ${names.join(' · ')}`;
            for (const o of group) {
                result.set(o.id, combined);
            }
        }
        return result;
    }

    /**
     * Get all waybills for a specific order
     */
    async getWaybillsByOrder(orderId: string) {
        const waybills = await this.prisma.shippingWaybill.findMany({
            where: { orderId },
            include: {
                issuer: { select: { id: true, name: true, role: true } },
                shipment: {
                    include: {
                        cartOffers: { include: { orderPart: true } },
                    },
                },
            },
            orderBy: { createdAt: 'asc' },
        });

        const offers = await this.prisma.offer.findMany({
            where: { orderId },
            include: { orderPart: true },
        });
        const offerById = new Map(offers.map((o) => [o.id, o]));

        const enriched = waybills.map((wb) => {
            const bundledIds = this.parseBundledOfferIds(wb.bundledOfferIds);
            const partNames =
                bundledIds.length > 0
                    ? bundledIds
                          .map((id) => offerById.get(id)?.orderPart?.name)
                          .filter(Boolean)
                    : wb.shipment?.cartOffers?.map((o) => o.orderPart?.name).filter(Boolean) ||
                      [];
            return {
                ...wb,
                bundledOfferIds: bundledIds,
                partNames,
                linkedShipmentId: wb.shipmentId,
                batchSize: bundledIds.length || partNames.length || 1,
            };
        });

        return { waybills: enriched };
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
