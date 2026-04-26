import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * SecurityMaintenanceService
 * Handles automated lifting of withdrawal freezes and security alerts.
 * Frequency: Every 30 Minutes
 */
@Injectable()
export class SecurityMaintenanceService {
    private readonly logger = new Logger(SecurityMaintenanceService.name);

    constructor(
        private prisma: PrismaService,
        private notifications: NotificationsService
    ) { }

    @Cron(CronExpression.EVERY_30_MINUTES)
    async handleExpiredWithdrawalFreezes() {
        const now = new Date();
        this.logger.log(`Checking for expired withdrawal freezes at ${now.toISOString()}...`);

        try {
            // Find users whose freeze period has expired
            const expiredFreezes = await this.prisma.user.findMany({
                where: {
                    withdrawalsFrozenUntil: {
                        lte: now,
                        not: null
                    }
                },
                select: {
                    id: true,
                    name: true,
                    role: true,
                    email: true
                }
            });

            if (expiredFreezes.length === 0) {
                return;
            }

            this.logger.log(`Found ${expiredFreezes.length} users to unfreeze withdrawals.`);

            for (const user of expiredFreezes) {
                await this.prisma.$transaction(async (tx) => {
                    // 1. Unfreeze withdrawals
                    await tx.user.update({
                        where: { id: user.id },
                        data: { withdrawalsFrozenUntil: null }
                    });

                    // 2. Notify User (Bilingual)
                    await this.notifications.notifyUser(user.id, user.role, {
                        titleAr: 'ميزة السحب متاحة الآن',
                        titleEn: 'Withdrawals are now available',
                        messageAr: 'لقد انتهت فترة تجميد السحب الأمنية (12 ساعة). يمكنك الآن إجراء عمليات السحب بشكل طبيعي.',
                        messageEn: 'The security withdrawal freeze (12 hours) has ended. you can now perform withdrawals normally.',
                        type: 'system'
                    });
                });

                this.logger.log(`User [${user.name}] unfrozen and notified.`);
            }
        } catch (error) {
            this.logger.error('Failed to process expired withdrawal freezes:', error.stack);
        }
    }
}
