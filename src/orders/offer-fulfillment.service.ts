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

import { POST_DELIVERY_RETURN_DISPUTE_HOURS } from './order-time.constants';
import { aggregateMultiItemDeliveryStatus } from './offer-resolution.helpers';

const FULFILLMENT_RANK: Record<OfferFulfillmentStatus, number> = {
    [OfferFulfillmentStatus.AWAITING_PAYMENT]: 0,
    [OfferFulfillmentStatus.IN_PREPARATION]: 10,
    [OfferFulfillmentStatus.PREPARED]: 20,
    [OfferFulfillmentStatus.VERIFICATION]: 30,
    [OfferFulfillmentStatus.VERIFICATION_SUCCESS]: 40,
    [OfferFulfillmentStatus.READY_FOR_SHIPPING]: 50,
    [OfferFulfillmentStatus.SHIPPED]: 60,
    [OfferFulfillmentStatus.DELIVERED]: 70,
    [OfferFulfillmentStatus.COMPLETED]: 80,
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
                o.fulfillmentStatus === OfferFulfillmentStatus.DELIVERED ||
                o.fulfillmentStatus === OfferFulfillmentStatus.COMPLETED,
        ).length;

        if (shippedCount > 0 && shippedCount < paidOffers.length) {
            return OrderStatus.PARTIALLY_SHIPPED;
        }
        if (shippedCount === paidOffers.length && shippedCount > 0) {
            return aggregateMultiItemDeliveryStatus(
                paidOffers.map((o) => o.fulfillmentStatus),
            );
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
            // Multi-part orders follow the slowest offer; backward steps are valid
            // (e.g. VERIFICATION → PREPARED when one part is approved but others are not verified yet).

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
            [OrderStatus.PARTIALLY_DELIVERED]: OfferFulfillmentStatus.DELIVERED,
            [OrderStatus.DELIVERED]: OfferFulfillmentStatus.DELIVERED,
            [OrderStatus.COMPLETED]: OfferFulfillmentStatus.COMPLETED,
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

        const canSubmitFresh = offer.fulfillmentStatus === OfferFulfillmentStatus.PREPARED;
        const canResubmit =
            offer.fulfillmentStatus === OfferFulfillmentStatus.VERIFICATION;

        if (!canSubmitFresh && !canResubmit) {
            throw new BadRequestException(
                `Cannot submit verification while offer is ${offer.fulfillmentStatus}. Mark the part as prepared first.`,
            );
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

        if (!parsedImages.length) {
            throw new BadRequestException('At least one verification image is required.');
        }
        if (!data.videoUrl || typeof data.videoUrl !== 'string') {
            throw new BadRequestException('Verification video URL is required.');
        }
        if (!String(data.videoUrl).startsWith('http')) {
            throw new BadRequestException('Verification video must be uploaded before submitting.');
        }

        const docPayload = {
            images: parsedImages as Prisma.InputJsonValue,
            videoUrl: data.videoUrl,
            description: data.description,
            recipientName: data.recipientName,
            recipientSignature: data.recipientSignature,
            signatureType: data.signatureType || 'DRAWN',
            signatureText: data.signatureText || null,
            handoverDate: data.handoverDate ? new Date(data.handoverDate) : null,
            handoverTime: data.handoverTime,
        };

        const partName = this.partLabel(offer, order);

        if (canResubmit) {
            const pending = await this.prisma.verificationDocument.findFirst({
                where: { orderId, offerId, adminStatus: 'PENDING' },
                orderBy: { createdAt: 'desc' },
            });
            if (pending) {
                await this.prisma.verificationDocument.update({
                    where: { id: pending.id },
                    data: docPayload,
                });
                return { success: true, orderStatus: order.status, updated: true };
            }
            throw new BadRequestException(
                'Verification is already under admin review and cannot be changed.',
            );
        }

        await this.prisma.$transaction([
            this.prisma.verificationDocument.create({
                data: {
                    orderId,
                    offerId,
                    storeId,
                    ...docPayload,
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
            deliveredAt?: Date | null;
            completedAt?: Date | null;
            resolutionLocked?: boolean;
            hasOpenCase?: boolean;
            warrantyEndAt?: Date | null;
        }>,
    ) {
        const total = paidOffers.length;
        const stepCounts = {
            preparation: 0,
            prepared: 0,
            verification: 0,
            verificationSuccess: 0,
            handoverPending: 0,
            readyForShipping: 0,
            shipped: 0,
            inCart: 0,
        };

        for (const o of paidOffers) {
            const r = FULFILLMENT_RANK[o.fulfillmentStatus] ?? 0;
            if (r >= FULFILLMENT_RANK.IN_PREPARATION) stepCounts.preparation++;
            if (r >= FULFILLMENT_RANK.PREPARED) stepCounts.prepared++;
            if (r >= FULFILLMENT_RANK.VERIFICATION) stepCounts.verification++;
            if (r >= FULFILLMENT_RANK.VERIFICATION_SUCCESS) {
                stepCounts.verificationSuccess++;
            }
            if (o.fulfillmentStatus === OfferFulfillmentStatus.VERIFICATION_SUCCESS) {
                stepCounts.handoverPending++;
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
            if (!o.shippedFromCart) {
                stepCounts.inCart++;
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
                orderPartId: o.orderPartId ?? null,
                partName: o.orderPart?.name || 'Part',
                fulfillmentStatus: o.fulfillmentStatus,
                canSelectForShipping:
                    o.fulfillmentStatus === OfferFulfillmentStatus.READY_FOR_SHIPPING &&
                    !o.shippedFromCart,
                ...this.buildOfferResolutionMeta(o, !!o.hasOpenCase),
            })),
        };
    }

    getLockReason(
        status: OfferFulfillmentStatus,
    ): { ar: string; en: string } {
        switch (status) {
            case OfferFulfillmentStatus.COMPLETED:
                return {
                    ar: 'انتهت مهلة الإرجاع — القطعة مكتملة',
                    en: 'Return window closed — item completed',
                };
            case OfferFulfillmentStatus.DELIVERED:
                return {
                    ar: 'وصلت — مهلة الإرجاع/النزاع نشطة',
                    en: 'Delivered — return/dispute window active',
                };
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
                    ar: 'بانتظار تسليم التاجر للإدارة',
                    en: 'Awaiting merchant handover to admin',
                };
            default:
                return {
                    ar: 'غير جاهزة للشحن بعد',
                    en: 'Not ready for shipping yet',
                };
        }
    }

    isMultiItemOrder(order: { requestType?: string | null; parts?: unknown[] | null }) {
        return (
            String(order.requestType || '').toLowerCase() === 'multiple' ||
            (order.parts?.length ?? 0) > 1
        );
    }

    getOfferReturnWindowEndsAt(offer: { deliveredAt?: Date | null }) {
        if (!offer.deliveredAt) return null;
        const windowMs = POST_DELIVERY_RETURN_DISPUTE_HOURS * 60 * 60 * 1000;
        return new Date(offer.deliveredAt.getTime() + windowMs);
    }

    isOfferReturnEligible(offer: {
        fulfillmentStatus: OfferFulfillmentStatus;
        deliveredAt?: Date | null;
        resolutionLocked?: boolean;
    }) {
        if (offer.resolutionLocked) return false;
        if (offer.fulfillmentStatus === OfferFulfillmentStatus.COMPLETED) return false;
        if (offer.fulfillmentStatus !== OfferFulfillmentStatus.DELIVERED) return false;
        if (!offer.deliveredAt) return false;
        const endsAt = this.getOfferReturnWindowEndsAt(offer);
        return endsAt != null && Date.now() <= endsAt.getTime();
    }

    async hasOpenCaseForOffer(
        offerId: string,
        orderPartId?: string | null,
        tx?: Prisma.TransactionClient,
    ) {
        const db = tx || this.prisma;
        const [openReturn, openDispute] = await Promise.all([
            db.returnRequest.findFirst({
                where: {
                    offerId,
                    status: { notIn: ['CANCELLED', 'REJECTED', 'REFUNDED', 'RESOLVED'] },
                },
            }),
            db.dispute.findFirst({
                where: {
                    offerId,
                    status: { notIn: ['CLOSED', 'RESOLVED'] },
                },
            }),
        ]);
        if (openReturn || openDispute) return true;
        if (orderPartId) {
            const [partReturn, partDispute] = await Promise.all([
                db.returnRequest.findFirst({
                    where: {
                        orderPartId,
                        status: { notIn: ['CANCELLED', 'REJECTED', 'REFUNDED', 'RESOLVED'] },
                    },
                }),
                db.dispute.findFirst({
                    where: {
                        orderPartId,
                        status: { notIn: ['CLOSED', 'RESOLVED'] },
                    },
                }),
            ]);
            return !!(partReturn || partDispute);
        }
        return false;
    }

    assertOfferReturnWindow(offer: {
        id: string;
        fulfillmentStatus: OfferFulfillmentStatus;
        deliveredAt?: Date | null;
        resolutionLocked?: boolean;
        orderPart?: { name: string } | null;
    }) {
        const partName = offer.orderPart?.name || 'this item';
        if (offer.resolutionLocked || offer.fulfillmentStatus === OfferFulfillmentStatus.COMPLETED) {
            throw new BadRequestException(
                `Return/dispute window has closed for "${partName}" (item completed).`,
            );
        }
        if (offer.fulfillmentStatus !== OfferFulfillmentStatus.DELIVERED) {
            throw new BadRequestException(
                `"${partName}" must be delivered before requesting return or dispute.`,
            );
        }
        if (!offer.deliveredAt) {
            throw new BadRequestException(
                `Delivery timestamp missing for "${partName}". Please contact support.`,
            );
        }
        const endsAt = this.getOfferReturnWindowEndsAt(offer);
        if (!endsAt || Date.now() > endsAt.getTime()) {
            throw new BadRequestException(
                `Return/dispute window (${POST_DELIVERY_RETURN_DISPUTE_HOURS} hours) has expired for "${partName}".`,
            );
        }
    }

    async completeOfferAfterWindow(
        offerId: string,
        reason = 'System: Auto-completed after return/dispute window expired',
    ) {
        const windowMs = POST_DELIVERY_RETURN_DISPUTE_HOURS * 60 * 60 * 1000;
        const windowEnd = new Date(Date.now() - windowMs);

        const txnResult = await this.prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT id FROM offers WHERE id = ${offerId}::uuid FOR UPDATE`;

            const offer = await tx.offer.findUnique({
                where: { id: offerId },
                include: { orderPart: true, order: true },
            });
            if (!offer) return null;
            if (
                offer.fulfillmentStatus !== OfferFulfillmentStatus.DELIVERED ||
                offer.resolutionLocked ||
                !offer.deliveredAt ||
                offer.deliveredAt > windowEnd
            ) {
                return null;
            }

            const hasCase = await this.hasOpenCaseForOffer(
                offer.id,
                offer.orderPartId,
                tx,
            );
            if (hasCase) return null;

            const now = new Date();
            const warrantyData =
                offer.hasWarranty && offer.warrantyDuration
                    ? {
                          warrantyActiveAt: now,
                          warrantyEndAt: this.calculateWarrantyEndDate(
                              now,
                              offer.warrantyDuration,
                          ),
                      }
                    : {};

            const updated = await tx.offer.updateMany({
                where: {
                    id: offerId,
                    fulfillmentStatus: OfferFulfillmentStatus.DELIVERED,
                    resolutionLocked: false,
                    deliveredAt: { lte: windowEnd },
                },
                data: {
                    fulfillmentStatus: OfferFulfillmentStatus.COMPLETED,
                    completedAt: now,
                    resolutionLocked: true,
                    ...warrantyData,
                },
            });

            if (updated.count === 0) return null;
            return { offer, orderId: offer.orderId };
        });

        if (!txnResult) return null;

        await this.auditLogs.logAction({
            orderId: txnResult.orderId,
            action: 'OFFER_AUTO_COMPLETED',
            entity: 'Offer',
            actorType: ActorType.SYSTEM,
            actorId: 'OFFER_RESOLUTION_CRON',
            actorName: 'Offer Resolution',
            previousState: OfferFulfillmentStatus.DELIVERED,
            newState: OfferFulfillmentStatus.COMPLETED,
            reason,
            metadata: { offerId, partName: txnResult.offer.orderPart?.name },
        });

        const nextStatus = await this.recomputeOrderStatus(txnResult.orderId);
        return { offer: txnResult.offer, orderStatus: nextStatus };
    }

    buildOfferResolutionMeta(
        offer: {
            id: string;
            fulfillmentStatus: OfferFulfillmentStatus;
            deliveredAt?: Date | null;
            completedAt?: Date | null;
            resolutionLocked?: boolean;
            orderPartId?: string | null;
            warrantyEndAt?: Date | null;
        },
        hasOpenCase = false,
    ) {
        const endsAt = this.getOfferReturnWindowEndsAt(offer);
        const isReturnEligible =
            !hasOpenCase && this.isOfferReturnEligible(offer);
        return {
            deliveredAt: offer.deliveredAt?.toISOString() ?? null,
            completedAt: offer.completedAt?.toISOString() ?? null,
            returnWindowEndsAt: endsAt?.toISOString() ?? null,
            isReturnEligible,
            resolutionLocked: !!offer.resolutionLocked,
            hasOpenCase,
            warrantyEndAt: offer.warrantyEndAt?.toISOString() ?? null,
        };
    }

    private calculateWarrantyEndDate(startDate: Date, duration: string): Date {
        const date = new Date(startDate);
        const d = duration.toLowerCase();

        if (d.includes('day')) {
            const num = parseInt(d.match(/\d+/)?.[0] || '0', 10);
            date.setDate(date.getDate() + num);
        } else if (d.includes('month')) {
            const num = parseInt(d.match(/\d+/)?.[0] || '1', 10);
            date.setMonth(date.getMonth() + num);
        } else if (d.includes('year')) {
            const num = parseInt(d.match(/\d+/)?.[0] || '1', 10);
            date.setFullYear(date.getFullYear() + num);
        } else {
            date.setDate(date.getDate() + 15);
        }

        return date;
    }
}
