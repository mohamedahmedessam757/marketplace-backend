import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ViolationsService } from '../violations/violations.service';
import { ViolationTargetType } from '@prisma/client';

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
        private readonly violationsService: ViolationsService,
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

                    const violation = await this.violationsService.autoIssue({
                        code: 'LOW_OFFER_QUALITY',
                        targetUserId: store.ownerId,
                        targetStoreId: store.id,
                        targetType: ViolationTargetType.MERCHANT,
                        reason: `Offer edit/withdrawal rate ${violationRate.toFixed(1)}% exceeds 5% threshold.`,
                        metadata: {
                            violationRate,
                            totalOffers: store.totalOffersSent,
                            edits: store.editCount,
                            withdrawals: store.withdrawalCount,
                        },
                        dedupSuffix: `governance:${store.id}`,
                    });

                    if (violation) {
                        await this.notifications.notifyAdmins({
                            titleAr: 'تنبيه حوكمة: متجر عالي الخطورة',
                            titleEn: 'Governance Alert: High Risk Store',
                            messageAr: `المتجر "${store.name}" سجل نسبة مخالفات (تعديل/سحب عروض) بلغت ${violationRate.toFixed(1)}%. تم تسجيل مخالفة تلقائياً.`,
                            messageEn: `Store "${store.name}" has a high edit/withdrawal rate of ${violationRate.toFixed(1)}%. A violation was auto-recorded.`,
                            type: 'VIOLATION',
                            link: 'violations',
                            metadata: {
                                storeId: store.id,
                                violationId: violation.id,
                                violationRate,
                                tab: 'violations',
                            },
                        });
                    }
                }
            }
        } catch (error) {
            this.logger.error(`Merchant governance audit failed: ${error.message}`, error.stack);
        }
    }
}
