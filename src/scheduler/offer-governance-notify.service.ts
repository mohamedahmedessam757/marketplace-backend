import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStatus, ActorType } from '@prisma/client';
import { getVoluntaryWithdrawEnd } from '../offers/offer-governance.util';

@Injectable()
export class OfferGovernanceNotifyService {
    private readonly logger = new Logger(OfferGovernanceNotifyService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly notifications: NotificationsService,
    ) {}

    @Cron(CronExpression.EVERY_5_MINUTES)
    async handleVoluntaryWithdrawReminders() {
        if (!(await this.prisma.ensureConnected())) return;

        const now = new Date();
        const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);

        const offers = await this.prisma.offer.findMany({
            where: {
                isWithdrawn: false,
                status: 'pending',
                canEditUntil: { lte: now, gte: twoMinutesAgo },
                order: {
                    status: { in: [OrderStatus.COLLECTING_OFFERS, OrderStatus.AWAITING_OFFERS] },
                },
            },
            include: {
                order: {
                    select: {
                        id: true,
                        orderNumber: true,
                        revealOffersAt: true,
                        createdAt: true,
                    },
                },
                store: { select: { ownerId: true, name: true } },
            },
            take: 50,
        });

        for (const offer of offers) {
            if (!offer.store?.ownerId || !offer.order) continue;

            const voluntaryEnd = getVoluntaryWithdrawEnd({
                revealOffersAt: offer.order.revealOffersAt,
                createdAt: offer.order.createdAt,
            });
            if (now >= voluntaryEnd) continue;

            await this.notifyOnce(offer.id, offer.orderId, 'VOLUNTARY_WINDOW_OPENED', async () => {
                await this.notifications.create({
                    recipientId: offer.store!.ownerId!,
                    recipientRole: 'VENDOR',
                    titleAr: 'يمكنك الآن الانسحاب من الطلب',
                    titleEn: 'Voluntary Withdrawal Window Open',
                    messageAr: `انتهت مهلة التعديل المجاني لعرضك على الطلب #${offer.order!.orderNumber}. يمكنك الانسحاب الطوعي حتى ${voluntaryEnd.toLocaleString('ar-EG')}.`,
                    messageEn: `Your free edit window ended for order #${offer.order!.orderNumber}. You may voluntarily withdraw until ${voluntaryEnd.toISOString()}.`,
                    type: 'system_alert',
                    link: `/dashboard/merchant/orders/${offer.orderId}`,
                    metadata: { offerId: offer.id, notifyKey: 'VOLUNTARY_WINDOW_OPENED' },
                });
            });
        }

        const closingSoon = await this.prisma.offer.findMany({
            where: {
                isWithdrawn: false,
                status: 'pending',
                canEditUntil: { lt: now },
                order: {
                    status: { in: [OrderStatus.COLLECTING_OFFERS, OrderStatus.AWAITING_OFFERS] },
                },
            },
            include: {
                order: {
                    select: {
                        id: true,
                        orderNumber: true,
                        revealOffersAt: true,
                        createdAt: true,
                    },
                },
                store: { select: { ownerId: true } },
            },
            take: 50,
        });

        for (const offer of closingSoon) {
            if (!offer.store?.ownerId || !offer.order) continue;
            const voluntaryEnd = getVoluntaryWithdrawEnd({
                revealOffersAt: offer.order.revealOffersAt,
                createdAt: offer.order.createdAt,
            });
            const msUntilEnd = voluntaryEnd.getTime() - now.getTime();
            if (msUntilEnd <= 0 || msUntilEnd > 65 * 60 * 1000) continue;

            await this.notifyOnce(offer.id, offer.orderId, 'VOLUNTARY_WINDOW_CLOSING', async () => {
                await this.notifications.create({
                    recipientId: offer.store!.ownerId!,
                    recipientRole: 'VENDOR',
                    titleAr: 'تبقى ساعة واحدة للانسحاب من الطلب',
                    titleEn: '1 Hour Left to Withdraw from Request',
                    messageAr: `تبقى ساعة واحدة لإمكانية الانسحاب الطوعي من الطلب #${offer.order!.orderNumber} قبل مرحلة اختيار العميل.`,
                    messageEn: `One hour remains to voluntarily withdraw from request #${offer.order!.orderNumber} before customer selection.`,
                    type: 'system_alert',
                    link: `/dashboard/merchant/orders/${offer.orderId}`,
                    metadata: { offerId: offer.id, notifyKey: 'VOLUNTARY_WINDOW_CLOSING' },
                });
            });
        }
    }

    private async notifyOnce(
        offerId: string,
        orderId: string,
        action: string,
        send: () => Promise<void>,
    ) {
        const existing = await this.prisma.auditLog.findFirst({
            where: {
                orderId,
                action,
                metadata: { path: ['offerId'], equals: offerId },
            },
        });
        if (existing) return;

        try {
            await send();
            await this.prisma.auditLog.create({
                data: {
                    orderId,
                    action,
                    entity: 'Offer',
                    actorType: ActorType.SYSTEM,
                    actorId: 'offer-governance-cron',
                    actorName: 'Offer Governance Cron',
                    metadata: { offerId },
                },
            });
        } catch (err) {
            this.logger.warn(`Failed governance notify ${action} for offer ${offerId}: ${(err as Error).message}`);
        }
    }
}
