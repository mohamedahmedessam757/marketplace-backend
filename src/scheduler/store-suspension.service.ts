import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

/**
 * StoreSuspensionService
 * Handles automated lifting of temporary store suspensions.
 * Frequency: Every 12 Minutes (as requested per 2026 Admin Optimization standards).
 */
@Injectable()
export class StoreSuspensionService {
    private readonly logger = new Logger(StoreSuspensionService.name);

    constructor(
        private prisma: PrismaService,
        private notifications: NotificationsService,
        private auditLogs: AuditLogsService,
    ) { }

    @Cron('*/12 * * * *')
    async handleExpiredSuspensions() {
        const now = new Date();
        this.logger.log(`Checking for expired suspensions at ${now.toISOString()}...`);

        try {
            // Find stores that are suspended and their time has passed
            const expiredStores = await this.prisma.store.findMany({
                where: {
                    status: 'SUSPENDED',
                    suspendedUntil: {
                        lte: now,
                        not: null
                    }
                },
                select: {
                    id: true,
                    name: true,
                    ownerId: true,
                    status: true
                }
            });

            if (expiredStores.length === 0) {
                return;
            }

            this.logger.log(`Found ${expiredStores.length} stores to re-activate.`);

            for (const store of expiredStores) {
                await this.prisma.$transaction(async (tx) => {
                    // 1. Update store status
                    await tx.store.update({
                        where: { id: store.id },
                        data: {
                            status: 'ACTIVE',
                            suspendedUntil: null
                        }
                    });

                    // 2. Task 10.4: Log the action in Audit Logs as SYSTEM
                    await this.auditLogs.logAction({
                        action: 'AUTO_UNBAN',
                        entity: 'STORE',
                        actorType: 'SYSTEM',
                        actorName: 'Scheduler:StoreSuspension',
                        reason: 'Suspension period expired (Standard Protocol 2026)',
                        metadata: {
                            storeId: store.id,
                            storeName: store.name,
                            previousStatus: 'SUSPENDED'
                        }
                    }, tx);

                    // 3. Task 10.5: Bilingual Notifications
                    // Notify Store Owner
                    await this.notifications.notifyUser(store.ownerId, 'VENDOR', {
                        titleAr: 'متجرك الآن نشط',
                        titleEn: 'Your store is now ACTIVE',
                        messageAr: `انتهت فترة الإيقاف المؤقت لمتجر [${store.name}]. يمكنك الآن استئناف نشاطك التجاري.`,
                        messageEn: `The temporary suspension for store [${store.name}] has ended. You can now resume your operations.`,
                        type: 'system',
                        metadata: { storeId: store.id }
                    });

                    // Notify Admins
                    await this.notifications.notifyAdmins({
                        titleAr: 'تنبيه النظام: إعادة تفعيل متجر',
                        titleEn: 'System Alert: Store Reactivated',
                        messageAr: `تمت إعادة تفعيل متجر [${store.name}] تلقائياً بعد انتهاء فترة الإيقاف.`,
                        messageEn: `Store [${store.name}] has been automatically reactivated after the suspension period expired.`,
                        type: 'alert',
                        metadata: { storeId: store.id }
                    });
                });

                this.logger.log(`Store [${store.name}] reactivated and parties notified.`);
            }
        } catch (error) {
            this.logger.error('Failed to process expired suspensions:', error.stack);
        }
    }
}
