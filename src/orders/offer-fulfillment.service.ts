import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import {
    ActorType,
    OfferFulfillmentStatus,
    OrderStatus,
    Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStateMachine } from './fsm/order-state-machine.service';

const FULFILLMENT_RANK: Record<OfferFulfillmentStatus, number> = {
    [OfferFulfillmentStatus.AWAITING_PAYMENT]: 0,
    [OfferFulfillmentStatus.IN_PREPARATION]: 10,
    [OfferFulfillmentStatus.PREPARED]: 20,
    [OfferFulfillmentStatus.VERIFICATION]: 30,
    [OfferFulfillmentStatus.VERIFICATION_SUCCESS]: 40,
    [OfferFulfillmentStatus.READY_FOR_SHIPPING]: 50,
    [OfferFulfillmentStatus.SHIPPED]: 60,
    [OfferFulfillmentStatus.DELIVERED]: 70,
    [OfferFulfillmentStatus.CANCELLED]: -1,
};

type OfferWithPayments = Prisma.OfferGetPayload<{
    include: { payments: true; orderPart: true; store: true };
}>;

@Injectable()
export class OfferFulfillmentService {
    constructor(
        private prisma: PrismaService,
        private fsm: OrderStateMachine,
        private auditLogs: AuditLogsService,
        private notifications: NotificationsService,
    ) {}

    private isAcceptedOffer(status: string) {
        return ['accepted', 'ACCEPTED'].includes(String(status));
    }

    private hasSuccessfulPayment(offer: OfferWithPayments) {
        return offer.payments?.some((p) => p.status === 'SUCCESS') ?? false;
    }

    private partLabel(offer: OfferWithPayments, order: { partName: string }) {
        return offer.orderPart?.name || order.partName || 'Part';
    }

    async getPaidAcceptedOffers(orderId: string): Promise<OfferWithPayments[]> {
        const offers = await this.prisma.offer.findMany({
            where: { orderId, status: { in: ['accepted', 'ACCEPTED'] } },
            include: {
                payments: { where: { status: 'SUCCESS' } },
                orderPart: true,
                store: true,
            },
        });
        return offers.filter((o) => this.hasSuccessfulPayment(o));
    }

    aggregateOrderStatusFromOffers(
        allAccepted: OfferWithPayments[],
        paidOffers: OfferWithPayments[],
    ): OrderStatus {
        if (allAccepted.length === 0) {
            return OrderStatus.COLLECTING_OFFERS;
        }
        if (paidOffers.length === 0) {
            return OrderStatus.AWAITING_PAYMENT;
        }
        if (paidOffers.length < allAccepted.length) {
            return OrderStatus.PARTIALLY_PAID;
        }

        const shippedCount = paidOffers.filter(
            (o) =>
                o.shippedFromCart ||
                o.fulfillmentStatus === OfferFulfillmentStatus.SHIPPED ||
                o.fulfillmentStatus === OfferFulfillmentStatus.DELIVERED,
        ).length;

        if (shippedCount > 0 && shippedCount < paidOffers.length) {
            return OrderStatus.PARTIALLY_SHIPPED;
        }
        if (shippedCount === paidOffers.length && shippedCount > 0) {
            return OrderStatus.SHIPPED;
        }

        const minRank = Math.min(
            ...paidOffers.map((o) => FULFILLMENT_RANK[o.fulfillmentStatus] ?? 0),
        );

        if (minRank <= FULFILLMENT_RANK.IN_PREPARATION) {
            return OrderStatus.PREPARATION;
        }
        if (minRank <= FULFILLMENT_RANK.PREPARED) {
            return OrderStatus.PREPARED;
        }
        if (minRank <= FULFILLMENT_RANK.VERIFICATION) {
            return OrderStatus.VERIFICATION;
        }
        if (minRank <= FULFILLMENT_RANK.VERIFICATION_SUCCESS) {
            return OrderStatus.VERIFICATION_SUCCESS;
        }
        return OrderStatus.READY_FOR_SHIPPING;
    }

    async recomputeOrderStatus(orderId: string): Promise<OrderStatus> {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: {
                offers: {
                    where: { status: { in: ['accepted', 'ACCEPTED'] } },
                    include: {
                        payments: { where: { status: 'SUCCESS' } },
                        orderPart: true,
                        store: true,
                    },
                },
            },
        });
        if (!order) throw new NotFoundException('Order not found');

        const allAccepted = order.offers as OfferWithPayments[];
        const paidOffers = allAccepted.filter((o) => this.hasSuccessfulPayment(o));
        const nextStatus = this.aggregateOrderStatusFromOffers(
            allAccepted,
            paidOffers,
        );

        if (order.status !== nextStatus) {
            try {
                this.fsm.validateTransition(order.status, nextStatus);
            } catch {
                // Aggregated status may skip intermediate FSM steps for multi-part; allow safe forward jumps
                const forwardOnly =
                    FULFILLMENT_RANK[
                        this.orderStatusToFulfillmentFloor(nextStatus)
                    ] >=
                    FULFILLMENT_RANK[
                        this.orderStatusToFulfillmentFloor(order.status)
                    ];
                if (!forwardOnly) {
                    throw new BadRequestException(
                        `Cannot aggregate order to ${nextStatus} from ${order.status}`,
                    );
                }
            }

            await this.prisma.order.update({
                where: { id: orderId },
                data: { status: nextStatus },
            });

            await this.auditLogs.logAction({
                orderId,
                action: 'AGGREGATE_STATUS',
                entity: 'Order',
                actorType: ActorType.SYSTEM,
                actorId: 'FULFILLMENT_ENGINE',
                actorName: 'Offer Fulfillment',
                previousState: order.status,
                newState: nextStatus,
                reason: 'Recomputed from per-offer fulfillment statuses',
            });
        }

        return nextStatus;
    }

    private orderStatusToFulfillmentFloor(
        status: OrderStatus,
    ): OfferFulfillmentStatus {
        const map: Partial<Record<OrderStatus, OfferFulfillmentStatus>> = {
            [OrderStatus.AWAITING_PAYMENT]: OfferFulfillmentStatus.AWAITING_PAYMENT,
            [OrderStatus.PARTIALLY_PAID]: OfferFulfillmentStatus.AWAITING_PAYMENT,
            [OrderStatus.PREPARATION]: OfferFulfillmentStatus.IN_PREPARATION,
            [OrderStatus.DELAYED_PREPARATION]: OfferFulfillmentStatus.IN_PREPARATION,
            [OrderStatus.PREPARED]: OfferFulfillmentStatus.PREPARED,
            [OrderStatus.VERIFICATION]: OfferFulfillmentStatus.VERIFICATION,
            [OrderStatus.CORRECTION_SUBMITTED]: OfferFulfillmentStatus.VERIFICATION,
            [OrderStatus.NON_MATCHING]: OfferFulfillmentStatus.PREPARED,
            [OrderStatus.VERIFICATION_SUCCESS]:
                OfferFulfillmentStatus.VERIFICATION_SUCCESS,
            [OrderStatus.READY_FOR_SHIPPING]:
                OfferFulfillmentStatus.READY_FOR_SHIPPING,
            [OrderStatus.PARTIALLY_SHIPPED]: OfferFulfillmentStatus.READY_FOR_SHIPPING,
            [OrderStatus.SHIPPED]: OfferFulfillmentStatus.SHIPPED,
            [OrderStatus.DELIVERED]: OfferFulfillmentStatus.DELIVERED,
        };
        return map[status] ?? OfferFulfillmentStatus.AWAITING_PAYMENT;
    }

    async markOfferPaid(offerId: string, orderId: string) {
        await this.prisma.offer.update({
            where: { id: offerId },
            data: { fulfillmentStatus: OfferFulfillmentStatus.IN_PREPARATION },
        });
        return this.recomputeOrderStatus(orderId);
    }

    async assertMerchantOffer(
        orderId: string,
        offerId: string,
        storeId: string,
    ): Promise<OfferWithPayments> {
        const offer = await this.prisma.offer.findFirst({
            where: { id: offerId, orderId, storeId },
            include: {
                payments: { where: { status: 'SUCCESS' } },
                orderPart: true,
                store: true,
            },
        });
        if (!offer || !this.isAcceptedOffer(offer.status)) {
            throw new ForbiddenException('No accepted offer for your store on this order.');
        }
        if (!this.hasSuccessfulPayment(offer)) {
            throw new BadRequestException('Offer must be paid before fulfillment actions.');
        }
        return offer;
    }

    async markOfferPrepared(orderId: string, offerId: string, storeId: string) {
        const offer = await this.assertMerchantOffer(orderId, offerId, storeId);
        const order = await this.prisma.order.findUnique({ where: { id: orderId } });
        if (!order) throw new NotFoundException('Order not found');

        if (
            offer.fulfillmentStatus !== OfferFulfillmentStatus.IN_PREPARATION &&
            offer.fulfillmentStatus !== OfferFulfillmentStatus.PREPARED
        ) {
            throw new BadRequestException(
                `Offer cannot be marked prepared from ${offer.fulfillmentStatus}`,
            );
        }

        await this.prisma.offer.update({
            where: { id: offerId },
            data: {
                fulfillmentStatus: OfferFulfillmentStatus.PREPARED,
                preparedAt: new Date(),
            },
        });

        const partName = this.partLabel(offer, order);
        const prevOrderStatus = order.status;
        const newStatus = await this.recomputeOrderStatus(orderId);

        await this.auditLogs.logAction({
            orderId,
            action: 'MARK_OFFER_PREPARED',
            entity: 'Offer',
            actorType: ActorType.VENDOR,
            actorId: storeId,
            actorName: 'Store Vendor',
            previousState: offer.fulfillmentStatus,
            newState: OfferFulfillmentStatus.PREPARED,
            reason: `Prepared: ${partName}`,
            metadata: { offerId, partName },
        });

        await this.notifications.create({
            recipientId: order.customerId,
            recipientRole: 'CUSTOMER',
            titleAr: `تم تجهيز قطعة: ${partName}`,
            titleEn: `Part prepared: ${partName}`,
            messageAr: `أنهى التاجر تجهيز «${partName}» في الطلب #${order.orderNumber}. باقي القطع قيد المتابعة.`,
            messageEn: `Merchant finished preparing "${partName}" for order #${order.orderNumber}. Other parts may still be in progress.`,
            type: 'ORDER',
            link: `/dashboard/orders/${order.id}`,
            metadata: { offerId, orderId },
        }).catch(() => {});

        await this.notifications.notifyAdmins({
            titleAr: `تجهيز قطعة — #${order.orderNumber}`,
            titleEn: `Part prepared — #${order.orderNumber}`,
            messageAr: `تم تجهيز «${partName}» من قبل المتجر.`,
            messageEn: `Part "${partName}" marked prepared by merchant.`,
            type: 'ORDER',
            link: `/admin/orders/${order.id}`,
            metadata: { offerId, orderId },
        }).catch(() => {});

        if (newStatus === OrderStatus.PREPARED && prevOrderStatus !== OrderStatus.PREPARED) {
            await this.notifications.create({
                recipientId: order.customerId,
                recipientRole: 'CUSTOMER',
                titleAr: 'جميع القطع جاهزة للتوثيق',
                titleEn: 'All parts prepared',
                messageAr: `تم تجهيز جميع قطع الطلب #${order.orderNumber}. سيبدأ التوثيق قريباً.`,
                messageEn: `All parts for order #${order.orderNumber} are prepared.`,
                type: 'ORDER',
                link: `/dashboard/orders/${order.id}`,
            }).catch(() => {});
        }

        return { offerId, orderStatus: newStatus, fulfillmentStatus: OfferFulfillmentStatus.PREPARED };
    }

    /** Legacy: resolve merchant's offer on order when offerId omitted */
    async markAsPreparedForStore(orderId: string, storeId: string, offerId?: string) {
        if (offerId) {
            return this.markOfferPrepared(orderId, offerId, storeId);
        }
        const offer = await this.prisma.offer.findFirst({
            where: {
                orderId,
                storeId,
                status: { in: ['accepted', 'ACCEPTED'] },
            },
        });
        if (!offer) {
            throw new ForbiddenException('No accepted offer for your store.');
        }
        return this.markOfferPrepared(orderId, offer.id, storeId);
    }

    async submitOfferVerification(
        orderId: string,
        offerId: string,
        storeId: string,
        data: any,
    ) {
        const offer = await this.assertMerchantOffer(orderId, offerId, storeId);
        if (offer.fulfillmentStatus !== OfferFulfillmentStatus.PREPARED) {
            throw new BadRequestException('Offer must be PREPARED before verification.');
        }

        const order = await this.prisma.order.findUnique({ where: { id: orderId } });
        if (!order) throw new NotFoundException('Order not found');

        let parsedImages: unknown[] = [];
        if (typeof data.images === 'string') {
            try {
                parsedImages = JSON.parse(data.images);
            } catch {
                parsedImages = [data.images];
            }
        } else if (Array.isArray(data.images)) {
            parsedImages = data.images;
        }

        const partName = this.partLabel(offer, order);

        await this.prisma.$transaction([
            this.prisma.verificationDocument.create({
                data: {
                    orderId,
                    offerId,
                    storeId,
                    images: parsedImages as Prisma.InputJsonValue,
                    videoUrl: data.videoUrl,
                    description: data.description,
                    recipientName: data.recipientName,
                    recipientSignature: data.recipientSignature,
                    signatureType: data.signatureType || 'DRAWN',
                    signatureText: data.signatureText || null,
                    handoverDate: data.handoverDate ? new Date(data.handoverDate) : null,
                    handoverTime: data.handoverTime,
                },
            }),
            this.prisma.offer.update({
                where: { id: offerId },
                data: {
                    fulfillmentStatus: OfferFulfillmentStatus.VERIFICATION,
                    verificationSubmittedAt: new Date(),
                },
            }),
        ]);

        const newStatus = await this.recomputeOrderStatus(orderId);

        await this.notifications.notifyAdmins({
            titleAr: `توثيق قطعة — #${order.orderNumber}`,
            titleEn: `Part verification — #${order.orderNumber}`,
            messageAr: `رفع المتجر توثيق «${partName}».`,
            messageEn: `Merchant submitted verification for "${partName}".`,
            type: 'system_alert',
            link: `/admin/orders/${order.id}`,
            metadata: { offerId },
        }).catch(() => {});

        await this.notifications.create({
            recipientId: order.customerId,
            recipientRole: 'CUSTOMER',
            titleAr: `توثيق قيد المراجعة: ${partName}`,
            titleEn: `Verification in review: ${partName}`,
            messageAr: `تم رفع توثيق «${partName}» وهو قيد مراجعة الإدارة.`,
            messageEn: `Verification for "${partName}" is under admin review.`,
            type: 'ORDER',
            link: `/dashboard/orders/${order.id}`,
        }).catch(() => {});

        return { success: true, orderStatus: newStatus };
    }

    async applyVerificationDecision(
        orderId: string,
        offerId: string,
        approved: boolean,
    ) {
        const offer = await this.prisma.offer.findFirst({
            where: { id: offerId, orderId },
            include: { orderPart: true, store: true },
        });
        if (!offer) return;

        await this.prisma.offer.update({
            where: { id: offerId },
            data: {
                fulfillmentStatus: approved
                    ? OfferFulfillmentStatus.VERIFICATION_SUCCESS
                    : OfferFulfillmentStatus.PREPARED,
            },
        });

        await this.recomputeOrderStatus(orderId);
    }

    async markOfferReadyForShipping(
        orderId: string,
        offerId: string,
        storeId: string,
    ) {
        const offer = await this.assertMerchantOffer(orderId, offerId, storeId);
        if (offer.fulfillmentStatus !== OfferFulfillmentStatus.VERIFICATION_SUCCESS) {
            throw new BadRequestException(
                'Offer must pass verification before ready for shipping.',
            );
        }

        const order = await this.prisma.order.findUnique({ where: { id: orderId } });
        if (!order) throw new NotFoundException('Order not found');

        await this.prisma.offer.update({
            where: { id: offerId },
            data: {
                fulfillmentStatus: OfferFulfillmentStatus.READY_FOR_SHIPPING,
                readyForShippingAt: new Date(),
            },
        });

        const partName = this.partLabel(offer, order);
        const newStatus = await this.recomputeOrderStatus(orderId);

        await this.notifications.create({
            recipientId: order.customerId,
            recipientRole: 'CUSTOMER',
            titleAr: `جاهزة للشحن: ${partName}`,
            titleEn: `Ready to ship: ${partName}`,
            messageAr: `«${partName}» جاهزة — يمكنك اختيارها من سلة الشحن عند الجاهزية.`,
            messageEn: `"${partName}" is ready — select it in the shipping cart when available.`,
            type: 'ORDER',
            link: `/dashboard/shipping-cart`,
            metadata: { offerId, orderId },
        }).catch(() => {});

        const paid = await this.getPaidAcceptedOffers(orderId);
        const allReady = paid.every(
            (o) =>
                o.fulfillmentStatus === OfferFulfillmentStatus.READY_FOR_SHIPPING ||
                o.fulfillmentStatus === OfferFulfillmentStatus.SHIPPED,
        );
        if (allReady) {
            await this.notifications.create({
                recipientId: order.customerId,
                recipientRole: 'CUSTOMER',
                titleAr: 'كل القطع جاهزة للشحن',
                titleEn: 'All parts ready to ship',
                messageAr: `جميع قطع الطلب #${order.orderNumber} جاهزة في سلة الشحن.`,
                messageEn: `All parts for order #${order.orderNumber} are ready in your shipping cart.`,
                type: 'ORDER',
                link: `/dashboard/shipping-cart`,
            }).catch(() => {});
        }

        return { orderStatus: newStatus, fulfillmentStatus: OfferFulfillmentStatus.READY_FOR_SHIPPING };
    }

    async markOfferReadyForStore(orderId: string, storeId: string, offerId?: string) {
        if (offerId) {
            return this.markOfferReadyForShipping(orderId, offerId, storeId);
        }
        const offer = await this.prisma.offer.findFirst({
            where: {
                orderId,
                storeId,
                status: { in: ['accepted', 'ACCEPTED'] },
            },
        });
        if (!offer) throw new ForbiddenException('No accepted offer for your store.');
        return this.markOfferReadyForShipping(orderId, offer.id, storeId);
    }

    async markOffersShippedFromCart(offerIds: string[]) {
        if (!offerIds.length) return;
        await this.prisma.offer.updateMany({
            where: { id: { in: offerIds } },
            data: { fulfillmentStatus: OfferFulfillmentStatus.SHIPPED },
        });
        const offers = await this.prisma.offer.findMany({
            where: { id: { in: offerIds } },
            select: { orderId: true },
        });
        const orderIds = [...new Set(offers.map((o) => o.orderId))];
        for (const orderId of orderIds) {
            await this.recomputeOrderStatus(orderId);
        }
    }

    getFulfillmentSummary(
        paidOffers: Array<{
            id: string;
            fulfillmentStatus: OfferFulfillmentStatus;
            orderPartId?: string | null;
            orderPart?: { name: string } | null;
            shippedFromCart?: boolean;
        }>,
    ) {
        const total = paidOffers.length;
        const stepCounts = {
            preparation: 0,
            prepared: 0,
            verification: 0,
            verificationSuccess: 0,
            readyForShipping: 0,
            shipped: 0,
        };

        for (const o of paidOffers) {
            const r = FULFILLMENT_RANK[o.fulfillmentStatus] ?? 0;
            if (r >= FULFILLMENT_RANK.IN_PREPARATION) stepCounts.preparation++;
            if (r >= FULFILLMENT_RANK.PREPARED) stepCounts.prepared++;
            if (r >= FULFILLMENT_RANK.VERIFICATION) stepCounts.verification++;
            if (r >= FULFILLMENT_RANK.VERIFICATION_SUCCESS) {
                stepCounts.verificationSuccess++;
            }
            if (r >= FULFILLMENT_RANK.READY_FOR_SHIPPING) {
                stepCounts.readyForShipping++;
            }
            if (
                o.shippedFromCart ||
                o.fulfillmentStatus === OfferFulfillmentStatus.SHIPPED
            ) {
                stepCounts.shipped++;
            }
        }

        const minRank =
            total > 0
                ? Math.min(
                      ...paidOffers.map(
                          (o) => FULFILLMENT_RANK[o.fulfillmentStatus] ?? 0,
                      ),
                  )
                : 0;

        return {
            total,
            stepCounts,
            minRank,
            parts: paidOffers.map((o) => ({
                offerId: o.id,
                partName: o.orderPart?.name || 'Part',
                fulfillmentStatus: o.fulfillmentStatus,
                canSelectForShipping:
                    o.fulfillmentStatus === OfferFulfillmentStatus.READY_FOR_SHIPPING &&
                    !o.shippedFromCart,
            })),
        };
    }

    getLockReason(
        status: OfferFulfillmentStatus,
    ): { ar: string; en: string } {
        switch (status) {
            case OfferFulfillmentStatus.IN_PREPARATION:
            case OfferFulfillmentStatus.AWAITING_PAYMENT:
                return {
                    ar: 'بانتظار تجهيز التاجر',
                    en: 'Awaiting merchant preparation',
                };
            case OfferFulfillmentStatus.PREPARED:
                return {
                    ar: 'بانتظار رفع التوثيق',
                    en: 'Awaiting verification upload',
                };
            case OfferFulfillmentStatus.VERIFICATION:
                return {
                    ar: 'التوثيق قيد مراجعة الإدارة',
                    en: 'Verification under admin review',
                };
            case OfferFulfillmentStatus.VERIFICATION_SUCCESS:
                return {
                    ar: 'بانتظار تأكيد الجاهزية للشحن من التاجر',
                    en: 'Awaiting merchant ready-for-shipping',
                };
            default:
                return {
                    ar: 'غير جاهزة للشحن بعد',
                    en: 'Not ready for shipping yet',
                };
        }
    }
}
