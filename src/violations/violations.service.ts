import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { 
  IssueViolationDto, 
  SubmitAppealDto, 
  ReviewAppealDto, 
  CreateViolationTypeDto, 
  UpdateViolationTypeDto, 
  CreatePenaltyThresholdDto, 
  UpdatePenaltyThresholdDto, 
  ReviewPenaltyDto 
} from './dto';
import { ViolationTargetType, ViolationStatus, AppealStatus, PenaltyActionStatus, PenaltyActionType } from '@prisma/client';

@Injectable()
export class ViolationsService {
  private readonly logger = new Logger(ViolationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // --- VIOLATION TYPES (CRUD) ---

  async createViolationType(dto: CreateViolationTypeDto, adminId: string) {
    return this.prisma.violationType.create({
      data: {
        ...dto,
        createdBy: adminId,
      },
    });
  }

  async updateViolationType(id: string, dto: UpdateViolationTypeDto, adminId: string) {
    const previous = await this.prisma.violationType.findUnique({ where: { id } });
    if (!previous) throw new NotFoundException('Violation type not found');

    const updated = await this.prisma.violationType.update({
      where: { id },
      data: dto,
    });

    await this.auditLogs.logAction({
      action: 'UPDATE',
      entity: 'VIOLATION_TYPE',
      actorId: adminId,
      actorType: 'ADMIN',
      previousState: JSON.stringify(previous),
      newState: JSON.stringify(updated),
      reason: `Updated violation type: ${previous.nameEn}`,
      metadata: { typeId: id, changes: dto },
    });

    return updated;
  }

  async getViolationTypes(targetType?: ViolationTargetType, onlyActive = false) {
    return this.prisma.violationType.findMany({
      where: {
        ...(targetType ? { targetType } : {}),
        ...(onlyActive ? { isActive: true } : {}),
      },
    });
  }

  // --- PENALTY THRESHOLDS (CRUD) ---

  async createPenaltyThreshold(dto: CreatePenaltyThresholdDto) {
    return this.prisma.penaltyThreshold.create({
      data: dto,
    });
  }

  async updatePenaltyThreshold(id: string, dto: UpdatePenaltyThresholdDto) {
    return this.prisma.penaltyThreshold.update({
      where: { id },
      data: dto,
    });
  }

  async getPenaltyThresholds(targetType?: ViolationTargetType, onlyActive = false) {
    return this.prisma.penaltyThreshold.findMany({
      where: {
        ...(targetType ? { targetType } : {}),
        ...(onlyActive ? { isActive: true } : {}),
      },
      orderBy: { thresholdPoints: 'asc' },
    });
  }

  // --- ISSUING VIOLATIONS ---

  async issueViolation(dto: IssueViolationDto, issuerId: string) {
    const { typeId, targetUserId, targetStoreId, targetType, customPoints, customFineAmount, customDecayDays } = dto;

    // 1. Fetch Violation Type
    const vType = await this.prisma.violationType.findUnique({
      where: { id: typeId },
    });
    if (!vType) throw new NotFoundException('Violation type not found');

    const points = customPoints ?? vType.points;
    const fineAmount = customFineAmount ?? Number(vType.fineAmount);
    const decayDays = customDecayDays ?? vType.decayDays;
    const decayAt = new Date();
    decayAt.setDate(decayAt.getDate() + decayDays);

    return this.prisma.$transaction(async (tx) => {
      // 2. Create Violation Record
      const violation = await tx.violation.create({
        data: {
          typeId,
          targetUserId,
          targetStoreId,
          targetType,
          points,
          fineAmount,
          adminNotes: dto.adminNotes,
          orderId: dto.orderId,
          issuedBy: issuerId,
          decayAt,
        },
        include: { type: true },
      });

      // 3. Update User Score
      const user = await tx.user.findUnique({
        where: { id: targetUserId },
        select: { violationScore: true, customerBalance: true },
      });
      if (!user) throw new NotFoundException('Target user not found');

      const previousScore = user.violationScore;
      const newScore = previousScore + points;

      await tx.user.update({
        where: { id: targetUserId },
        data: { violationScore: newScore },
      });

      // 4. Log Score Change
      await tx.violationScoreLog.create({
        data: {
          targetUserId,
          targetType,
          previousScore,
          newScore,
          changeAmount: points,
          reason: `Violation Issued: ${vType.nameEn}`,
          violationId: violation.id,
        },
      });

      // 5. Deduct Fine automatically (if applicable)
      if (fineAmount > 0) {
        if (targetType === 'MERCHANT' && targetStoreId) {
          const store = await tx.store.findUnique({
            where: { id: targetStoreId },
          });
          if (store) {
            const newBalance = Number(store.balance) - fineAmount;
            await tx.store.update({
              where: { id: targetStoreId },
              data: { balance: newBalance },
            });

            await tx.walletTransaction.create({
              data: {
                userId: targetUserId,
                role: 'VENDOR',
                type: 'DEBIT',
                transactionType: 'penalty',
                amount: fineAmount,
                currency: 'AED',
                description: `Violation Fine: ${vType.nameAr} | ${vType.nameEn}`,
                balanceAfter: newBalance,
                metadata: { violationId: violation.id },
              },
            });
          }
        } else if (targetType === 'CUSTOMER') {
          const newBalance = Number(user.customerBalance) - fineAmount;
          await tx.user.update({
            where: { id: targetUserId },
            data: { customerBalance: newBalance },
          });

          await tx.walletTransaction.create({
            data: {
              userId: targetUserId,
              role: 'CUSTOMER',
              type: 'DEBIT',
              transactionType: 'penalty',
              amount: fineAmount,
              currency: 'AED',
              description: `مخالفة: ${vType.nameAr} | Penalty: ${vType.nameEn}`,
              balanceAfter: newBalance,
              metadata: { violationId: violation.id },
            },
          });
        }

        // Update Platform Wallet (Add to fees balance)
        const platformWallet = await tx.platformWallet.findFirst();
        if (platformWallet) {
          await tx.platformWallet.update({
            where: { id: platformWallet.id },
            data: { 
              feesBalance: Number(platformWallet.feesBalance) + fineAmount,
              totalRevenue: Number(platformWallet.totalRevenue) + fineAmount,
            },
          });
        }
      }

      // 6. Audit Log
      await this.auditLogs.logAction({
        action: 'CREATE',
        entity: 'VIOLATION',
        actorId: issuerId,
        actorType: 'ADMIN',
        reason: `Issued violation ${violation.id} to user ${targetUserId}`,
        metadata: { violationId: violation.id, points, fineAmount },
      }, tx);

      // 7. Notification (Bilingual)
      await this.notifications.create({
        recipientId: targetUserId,
        recipientRole: targetType === 'MERCHANT' ? 'VENDOR' : 'CUSTOMER',
        type: 'alert',
        titleAr: 'مخالفة جديدة مسجلة 🚨',
        titleEn: 'New Violation Recorded 🚨',
        messageAr: `تم تسجيل مخالفة "${vType.nameAr}" بحق حسابك. النقاط المسجلة: ${points}${fineAmount > 0 ? `، الغرامة: ${fineAmount} درهم` : ''}.`,
        messageEn: `A violation "${vType.nameEn}" has been recorded. Points: ${points}${fineAmount > 0 ? `, Fine: ${fineAmount} AED` : ''}.`,
        metadata: { violationId: violation.id, points, fineAmount },
      });

      // 7.1 Notify Admin Group (Oversight)
      await this.notifications.notifyAdmins({
        titleAr: 'تم تسجيل مخالفة 🛡️',
        titleEn: 'Violation Issued 🛡️',
        messageAr: `قام أدمن بتسجيل مخالفة (${vType.nameAr}) بحق المستخدم ${targetUserId}. النقاط: ${points}.`,
        messageEn: `Admin issued violation (${vType.nameEn}) to user ${targetUserId}. Points: ${points}.`,
        type: 'VIOLATION',
        metadata: { violationId: violation.id, targetUserId }
      });

      // 8. Check for Penalties
      await this.checkAndTriggerPenalty(targetUserId, targetType, newScore, targetStoreId, tx);

      return violation;
    });
  }

  // --- PENALTY CHECK LOGIC ---

  private async checkAndTriggerPenalty(userId: string, targetType: ViolationTargetType, score: number, storeId?: string, tx?: any) {
    const prisma = tx || this.prisma;

    // Find applicable thresholds that haven't been triggered yet
    const thresholds = await prisma.penaltyThreshold.findMany({
      where: {
        targetType,
        thresholdPoints: { lte: score },
        isActive: true,
      },
      orderBy: { thresholdPoints: 'desc' },
    });

    for (const threshold of thresholds) {
      // Check if this specific user/store already has a pending or executed action for THIS threshold level
      const existing = await prisma.penaltyAction.findFirst({
        where: {
          targetUserId: userId,
          thresholdId: threshold.id,
          status: { in: ['PENDING_APPROVAL', 'EXECUTED', 'DELAYED'] },
        },
      });

      if (!existing) {
        // Create a pending penalty action for admin approval
        await prisma.penaltyAction.create({
          data: {
            targetUserId: userId,
            targetStoreId: storeId,
            targetType,
            thresholdId: threshold.id,
            action: threshold.action,
            status: 'PENDING_APPROVAL',
            adminNotes: `Automatically triggered by score ${score} reaching threshold ${threshold.thresholdPoints}`,
          },
        });

        // Notify Admins
        await this.notifications.notifyAdmins({
          titleAr: 'عقوبة جديدة بانتظار الموافقة ⚠️',
          titleEn: 'New Penalty Pending Approval ⚠️',
          messageAr: `تجاوز مستخدم حد النقاط للعقوبة: ${threshold.nameAr}. يرجى المراجعة واتخاذ القرار.`,
          messageEn: `A user exceeded the points threshold for: ${threshold.nameEn}. Please review and take action.`,
          type: 'alert',
          metadata: { userId, thresholdId: threshold.id },
        });
      }
    }
  }

  // --- APPEALS ---

  async submitAppeal(violationId: string, userId: string, dto: SubmitAppealDto) {
    const violation = await this.prisma.violation.findUnique({
      where: { id: violationId },
    });

    if (!violation) throw new NotFoundException('Violation not found');
    if (violation.targetUserId !== userId) throw new BadRequestException('Not authorized to appeal this violation');
    if (violation.status !== 'ACTIVE') throw new BadRequestException('Violation is not in appealable state');

    return this.prisma.$transaction(async (tx) => {
      const appeal = await tx.violationAppeal.create({
        data: {
          violationId,
          userId,
          reason: dto.reason,
          description: dto.description,
          evidenceUrls: dto.evidenceUrls || [],
          status: 'PENDING',
        },
      });

      await tx.violation.update({
        where: { id: violationId },
        data: { status: 'APPEALED' },
      });

      // Notify Admins
      await this.notifications.notifyAdmins({
        titleAr: 'طلب طعن جديد 📝',
        titleEn: 'New Violation Appeal 📝',
        messageAr: `تم تقديم طلب طعن في المخالفة رقم ${violation.id.split('-').pop()}.`,
        messageEn: `An appeal has been submitted for violation #${violation.id.split('-').pop()}.`,
        type: 'support',
        metadata: { appealId: appeal.id, violationId },
      });

      return appeal;
    });
  }

  async reviewAppeal(appealId: string, adminId: string, dto: ReviewAppealDto) {
    const appeal = await this.prisma.violationAppeal.findUnique({
      where: { id: appealId },
      include: { violation: true },
    });

    if (!appeal) throw new NotFoundException('Appeal not found');

    return this.prisma.$transaction(async (tx) => {
      const updatedAppeal = await tx.violationAppeal.update({
        where: { id: appealId },
        data: {
          status: dto.status,
          adminResponse: dto.adminResponse,
          reviewedBy: adminId,
          reviewedAt: new Date(),
        },
      });

      if (dto.status === 'APPROVED') {
        // Drop violation points
        const pointsToDrop = appeal.violation.points;
        const user = await tx.user.findUnique({
          where: { id: appeal.userId },
          select: { violationScore: true },
        });

        const newScore = Math.max(0, (user?.violationScore || 0) - pointsToDrop);

        await tx.user.update({
          where: { id: appeal.userId },
          data: { violationScore: newScore },
        });

        await tx.violation.update({
          where: { id: appeal.violationId },
          data: { status: 'DROPPED' },
        });

        // Log score change
        await tx.violationScoreLog.create({
          data: {
            targetUserId: appeal.userId,
            targetType: appeal.violation.targetType,
            previousScore: user?.violationScore || 0,
            newScore,
            changeAmount: -pointsToDrop,
            reason: `Appeal Approved for violation ${appeal.violationId}`,
            violationId: appeal.violationId,
          },
        });
      } else {
        // Restore status to ACTIVE if rejected
        await tx.violation.update({
          where: { id: appeal.violationId },
          data: { status: 'ACTIVE' },
        });
      }

      // Notify User
      await this.notifications.create({
        recipientId: appeal.userId,
        recipientRole: appeal.violation.targetType === 'MERCHANT' ? 'VENDOR' : 'CUSTOMER',
        type: 'alert',
        titleAr: dto.status === 'APPROVED' ? 'تم قبول الطعن بنجاح ✅' : 'تم رفض الطعن ❌',
        titleEn: dto.status === 'APPROVED' ? 'Appeal Approved Successfully ✅' : 'Appeal Rejected ❌',
        messageAr: dto.status === 'APPROVED' 
          ? `تم قبول طلبك للطعن وتم إسقاط النقاط.` 
          : `نعتذر، تم رفض طلب الطعن. ملاحظات الأدمن: ${dto.adminResponse || 'لا يوجد'}`,
        messageEn: dto.status === 'APPROVED'
          ? `Your appeal has been approved and points have been dropped.`
          : `Your appeal has been rejected. Admin notes: ${dto.adminResponse || 'None'}`,
        metadata: { appealId, status: dto.status },
      });

      // Audit Log
      await this.auditLogs.logAction({
        action: 'UPDATE',
        entity: 'VIOLATION_APPEAL',
        actorId: adminId,
        actorType: 'ADMIN',
        reason: `Reviewed appeal ${appealId} - Result: ${dto.status}`,
        metadata: { appealId, status: dto.status, violationId: appeal.violationId },
      }, tx);

      return updatedAppeal;
    });
  }

  // --- PENALTY EXECUTION ---

  async reviewPenaltyAction(id: string, adminId: string, dto: ReviewPenaltyDto) {
    const penalty = await this.prisma.penaltyAction.findUnique({
      where: { id },
      include: { threshold: true },
    });

    if (!penalty) throw new NotFoundException('Penalty action not found');

    return this.prisma.$transaction(async (tx) => {
      const updatedPenalty = await tx.penaltyAction.update({
        where: { id },
        data: {
          status: dto.status,
          adminNotes: dto.adminNotes,
          approvedBy: adminId,
          approvedAt: new Date(),
        },
      });

      if (dto.status === 'APPROVED') {
        const { action, targetUserId, targetStoreId, targetType } = penalty;
        
        // Execute Action
        if (action === 'PERMANENT_BAN') {
          if (targetType === 'MERCHANT' && targetStoreId) {
            await tx.store.update({ where: { id: targetStoreId }, data: { status: 'BLOCKED' } });
          } else {
            await tx.user.update({ where: { id: targetUserId }, data: { status: 'BLOCKED' } });
          }
        } else if (action === 'TEMPORARY_SUSPENSION') {
          const duration = penalty.threshold?.suspendDurationDays || 7;
          const until = new Date();
          until.setDate(until.getDate() + duration);

          if (targetType === 'MERCHANT' && targetStoreId) {
            await tx.store.update({ where: { id: targetStoreId }, data: { status: 'SUSPENDED', suspendedUntil: until } });
          } else {
            // Standard user suspension (Note: Current User model doesn't have suspendedUntil, I should add it or use status)
            // For now, let's use status
            await tx.user.update({ where: { id: targetUserId }, data: { status: 'SUSPENDED' } });
          }
        }

        await tx.penaltyAction.update({
            where: { id },
            data: { executedAt: new Date() }
        });

        // Notify User
        await this.notifications.create({
          recipientId: targetUserId,
          recipientRole: targetType === 'MERCHANT' ? 'VENDOR' : 'CUSTOMER',
          type: 'alert',
          titleAr: 'تنبيه إداري: تطبيق عقوبة ⚠️',
          titleEn: 'Admin Alert: Penalty Applied ⚠️',
          messageAr: `تم تطبيق إجراء إداري بحق حسابك (${penalty.threshold?.nameAr}). السبب: تجاوز حد النقاط.`,
          messageEn: `An administrative action has been applied to your account (${penalty.threshold?.nameEn}) due to points threshold.`,
          metadata: { penaltyId: id, action },
        });
      }

      // Audit Log
      await this.auditLogs.logAction({
        action: 'UPDATE',
        entity: 'VIOLATION_PENALTY',
        actorId: adminId,
        actorType: 'ADMIN',
        reason: `Reviewed penalty action ${id} - Result: ${dto.status}`,
        metadata: { penaltyId: id, status: dto.status, action: penalty.action },
      }, tx);

      return updatedPenalty;
    });
  }

  // --- QUERY METHODS ---

  async getAllViolations(filters: any) {
    return this.prisma.violation.findMany({
      where: filters,
      include: { type: true, targetUser: true, targetStore: true, issuer: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getUserViolations(userId: string) {
    return this.prisma.violation.findMany({
      where: { targetUserId: userId },
      include: { type: true, appeals: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getViolationScore(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { violationScore: true },
    });
    return user?.violationScore || 0;
  }

  async getScoreHistory(userId: string) {
    return this.prisma.violationScoreLog.findMany({
      where: { targetUserId: userId },
      include: { violation: { include: { type: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getPendingAppeals() {
    return this.prisma.violationAppeal.findMany({
      where: { status: 'PENDING' },
      include: { violation: { include: { type: true } }, user: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getPendingPenalties() {
    return this.prisma.penaltyAction.findMany({
      where: { status: { in: ['PENDING_APPROVAL', 'DELAYED'] } },
      include: { targetUser: true, targetStore: true, threshold: true },
      orderBy: { createdAt: 'desc' },
    });
  }
}
