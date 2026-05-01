import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ActorType } from '@prisma/client';

/**
 * MerchantGovernanceService (2026 Compliance)
 * Monitors merchant behavior patterns (Edits & Withdrawals) vs Total Offers Sent.
 * Triggers administrative alerts if the violation rate exceeds 5%.
 */
@Injectable()
export class MerchantGovernanceService {
    private readonly logger = new Logger(MerchantGovernanceService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly notifications: NotificationsService,
    ) { }

    @Cron(CronExpression.EVERY_HOUR)
    async monitorMerchantCompliance() {
        this.logger.log('Starting merchant governance compliance audit...');

        try {
            // Find stores with enough volume to calculate a meaningful rate (e.g., > 10 offers)
            const activeStores = await this.prisma.store.findMany({
                where: {
                    totalOffersSent: { gt: 10 },
                    status: 'ACTIVE'
                },
                select: {
                    id: true,
                    name: true,
                    ownerId: true,
                    totalOffersSent: true,
                    editCount: true,
                    withdrawalCount: true
                }
            });

            for (const store of activeStores) {
                const totalViolations = store.editCount + store.withdrawalCount;
                const violationRate = (totalViolations / store.totalOffersSent) * 100;

                // 2026 Rule: Alert Admin if Violation Rate > 5%
                if (violationRate > 5) {
                    this.logger.warn(`Merchant Violation Alert: ${store.name} has a violation rate of ${violationRate.toFixed(2)}%`);

                    // 1. Notify Admins
                    await this.notifications.notifyAdmins({
                        titleAr: 'تنبيه حوكمة: متجر عالي الخطورة',
                        titleEn: 'Governance Alert: High Risk Store',
                        messageAr: `المتجر "${store.name}" سجل نسبة مخالفات (تعديل/سحب عروض) بلغت ${violationRate.toFixed(1)}%. يرجى مراجعة نشاط المتجر.`,
                        messageEn: `Store "${store.name}" has a high violation rate (Edits/Withdrawals) of ${violationRate.toFixed(1)}%. Please review store activity.`,
                        type: 'system_alert',
                        link: `/admin/stores/${store.id}`,
                        metadata: { 
                            storeId: store.id, 
                            violationRate, 
                            totalOffers: store.totalOffersSent,
                            edits: store.editCount,
                            withdrawals: store.withdrawalCount
                        }
                    });

                    // 2. Warn Merchant (Educational Warning before suspension)
                    await this.notifications.create({
                        recipientId: store.ownerId,
                        recipientRole: 'VENDOR',
                        titleAr: 'تنبيه بخصوص جودة العروض ⚠️',
                        titleEn: 'Notice Regarding Offer Quality ⚠️',
                        messageAr: 'نلاحظ كثرة التعديلات أو الانسحابات من عروضك. يرجى التأكد من دقة العرض قبل إرساله لتجنب تقييد حسابك مستقبلاً.',
                        messageEn: 'We have noticed a high rate of edits or withdrawals on your offers. Please ensure offer accuracy before submission to avoid future account restrictions.',
                        type: 'system_alert',
                        link: '/dashboard/merchant/governance'
                    }).catch(() => {});
                }
            }
        } catch (error) {
            this.logger.error(`Merchant governance audit failed: ${error.message}`, error.stack);
        }
    }
}
