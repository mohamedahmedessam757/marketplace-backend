import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

/**
 * ViolationDecayService
 * Handles automated decay of violation points and lifting of expired user penalties.
 * Frequency: Every Midnight (0 0 * * *)
 */
@Injectable()
export class ViolationDecayService {
  private readonly logger = new Logger(ViolationDecayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleViolationDecay() {
    const now = new Date();
    this.logger.log(`Starting violation decay process at ${now.toISOString()}...`);

    try {
      // 1. Find active violations that have reached their decay date
      const violationsToDecay = await this.prisma.violation.findMany({
        where: {
          status: 'ACTIVE',
          decayAt: { lte: now },
        },
        include: { type: true },
      });

      if (violationsToDecay.length === 0) {
        this.logger.log('No violations ready to decay.');
      } else {
        this.logger.log(`Found ${violationsToDecay.length} violations to decay.`);
        
        for (const violation of violationsToDecay) {
          await this.prisma.$transaction(async (tx) => {
            // Update violation status
            await tx.violation.update({
              where: { id: violation.id },
              data: { status: 'DECAYED' },
            });

            // Update user score
            const user = await tx.user.findUnique({
              where: { id: violation.targetUserId },
              select: { violationScore: true },
            });

            const previousScore = user?.violationScore || 0;
            const newScore = Math.max(0, previousScore - violation.points);

            await tx.user.update({
              where: { id: violation.targetUserId },
              data: { violationScore: newScore },
            });

            // Log score change
            await tx.violationScoreLog.create({
              data: {
                targetUserId: violation.targetUserId,
                targetType: violation.targetType,
                previousScore,
                newScore,
                changeAmount: -violation.points,
                reason: `Point Decay: ${violation.type.nameEn}`,
                violationId: violation.id,
              },
            });

            // Notify User
            await this.notifications.create({
              recipientId: violation.targetUserId,
              recipientRole: violation.targetType === 'MERCHANT' ? 'VENDOR' : 'CUSTOMER',
              type: 'system',
              titleAr: 'تحلل نقاط مخالفة 📉',
              titleEn: 'Violation Points Decayed 📉',
              messageAr: `انتهت فترة صلاحية نقاط المخالفة "${violation.type.nameAr}". تم استعادة ${violation.points} نقطة من رصيدك.`,
              messageEn: `Points for violation "${violation.type.nameEn}" have expired. ${violation.points} points restored to your balance.`,
              metadata: { violationId: violation.id },
            });
          });
        }
      }

      // 2. Handle expired penalty actions for non-store targets (Customers)
      // Stores are handled by StoreSuspensionService, but we can double check here
      const expiredPenalties = await this.prisma.penaltyAction.findMany({
        where: {
          status: 'EXECUTED',
          action: 'TEMPORARY_SUSPENSION',
          expiresAt: { lte: now },
        },
      });

      for (const penalty of expiredPenalties) {
        await this.prisma.$transaction(async (tx) => {
          // Re-activate target
          if (penalty.targetType === 'CUSTOMER') {
            await tx.user.update({
              where: { id: penalty.targetUserId },
              data: { status: 'ACTIVE' },
            });
          } else if (penalty.targetType === 'MERCHANT' && penalty.targetStoreId) {
            await tx.store.update({
              where: { id: penalty.targetStoreId },
              data: { status: 'ACTIVE', suspendedUntil: null },
            });
          }

          // Mark penalty as completed (using status logic - actually we can just leave it or maybe use metadata)
          // Since we don't have COMPLETED in enum, we'll keep it as EXECUTED but log it.
          
          await this.auditLogs.logAction({
            action: 'AUTO_UNBAN',
            entity: 'VIOLATION_PENALTY',
            actorType: 'SYSTEM',
            actorName: 'Scheduler:ViolationDecay',
            reason: 'Penalty period expired',
            metadata: { penaltyId: penalty.id, targetUserId: penalty.targetUserId },
          }, tx);

          // Notify User
          await this.notifications.create({
            recipientId: penalty.targetUserId,
            recipientRole: penalty.targetType === 'MERCHANT' ? 'VENDOR' : 'CUSTOMER',
            type: 'system',
            titleAr: 'انتهت فترة العقوبة 🔓',
            titleEn: 'Penalty Period Ended 🔓',
            messageAr: 'لقد انتهت فترة الإيقاف المؤقت لحسابك. يمكنك الآن استئناف استخدامه بشكل طبيعي.',
            messageEn: 'The temporary suspension for your account has ended. You can now use it normally.',
          });
        });
      }

    } catch (error) {
      this.logger.error(`Error in violation decay process: ${error.message}`, error.stack);
    }
  }
}
