import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
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
  ReviewPenaltyDto,
  ResolveRiskAlertDto 
} from './dto';
import {
  ViolationTargetType,
  ViolationStatus,
  AppealStatus,
  PenaltyActionStatus,
  PenaltyActionType,
  ViolationSource,
  LoyaltyImpact,
  LoyaltyReviewStatus,
  LoyaltyReviewTrigger,
  ViolationType,
} from '@prisma/client';
import { MerchantPerformanceService } from '../merchant-performance/merchant-performance.service';
import { LoyaltyService } from '../loyalty/loyalty.service';

/** Resolves a stable violation type by `code` with a small in-memory cache (5 min TTL). */
type CachedType = { type: ViolationType; expiresAt: number };
const TYPE_CACHE_TTL_MS = 5 * 60 * 1000;

export interface AutoIssueInput {
  code: string;
  targetUserId: string;
  targetType: ViolationTargetType;
  targetStoreId?: string | null;
  orderId?: string | null;
  reason?: string;
  metadata?: Record<string, any>;
  /** Optional unique key suffix when multiple violations of the same code can be valid for the same order. */
  dedupSuffix?: string;
}

@Injectable()
export class ViolationsService {
  private readonly logger = new Logger(ViolationsService.name);
  private readonly typeCache = new Map<string, CachedType>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly auditLogs: AuditLogsService,
    @Inject(forwardRef(() => MerchantPerformanceService))
    private readonly merchantPerformance: MerchantPerformanceService,
    @Inject(forwardRef(() => LoyaltyService))
    private readonly loyaltyService: LoyaltyService,
  ) {}

  private async resolveTypeByCode(code: string): Promise<ViolationType | null> {
    const cached = this.typeCache.get(code);
    if (cached && cached.expiresAt > Date.now()) return cached.type;

    const type = await this.prisma.violationType.findUnique({ where: { code } });
    if (type) {
      this.typeCache.set(code, { type, expiresAt: Date.now() + TYPE_CACHE_TTL_MS });
    }
    return type;
  }

  /** Public helper for tests / admin tooling to clear the cache after edits. */
  clearTypeCache() {
    this.typeCache.clear();
  }

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

  async issueViolation(dto: IssueViolationDto, issuerId: string | null, tx?: any) {
    const { typeId, targetUserId, targetStoreId, targetType, customPoints, customFineAmount, customDecayDays } = dto;
    const db = tx || this.prisma;

    // 1. Fetch Violation Type
    const vType = await db.violationType.findUnique({
      where: { id: typeId },
    });
    if (!vType) throw new NotFoundException('Violation type not found');

    const points = customPoints ?? vType.points;
    const fineAmount = customFineAmount ?? Number(vType.fineAmount);
    const decayDays = customDecayDays ?? vType.decayDays;
    const source = dto.source ?? ViolationSource.MANUAL;
    const decayAt = new Date();
    decayAt.setDate(decayAt.getDate() + decayDays);

    // 1.1 Idempotency short-circuit (when uniqueKey is provided, e.g. by autoIssue)
    if (dto.uniqueKey) {
      const existing = await db.violation.findUnique({
        where: { uniqueKey: dto.uniqueKey },
        include: { type: true },
      });
      if (existing) {
        this.logger.debug(`[autoIssue] Idempotent skip — existing violation for key ${dto.uniqueKey}`);
        return existing;
      }
    }

    const logic = async (itx: any) => {
      // 2. Create Violation Record
      const violation = await itx.violation.create({
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
          source,
          uniqueKey: dto.uniqueKey ?? null,
          decayAt,
        },
        include: { type: true },
      });

      // 3. Update User Score
      const user = await itx.user.findUnique({
        where: { id: targetUserId },
        select: { violationScore: true, customerBalance: true },
      });
      if (!user) throw new NotFoundException('Target user not found');

      const previousScore = user.violationScore;
      const newScore = previousScore + points;

      await itx.user.update({
        where: { id: targetUserId },
        data: { violationScore: newScore },
      });

      // 4. Log Score Change
      await itx.violationScoreLog.create({
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
          const store = await itx.store.findUnique({ where: { id: targetStoreId } });
          if (store) {
            const newBalance = Number(store.balance) - fineAmount;
            await itx.store.update({
              where: { id: targetStoreId },
              data: { balance: newBalance },
            });

            await itx.walletTransaction.create({
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
          await itx.user.update({
            where: { id: targetUserId },
            data: { customerBalance: newBalance },
          });

          await itx.walletTransaction.create({
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

        // 5.1 Update Platform Wallet (Add to fees balance)
        const platformWallet = await itx.platformWallet.findFirst();
        if (platformWallet) {
          await itx.platformWallet.update({
            where: { id: platformWallet.id },
            data: { 
              feesBalance: Number(platformWallet.feesBalance) + fineAmount,
              totalRevenue: Number(platformWallet.totalRevenue) + fineAmount,
            },
          });
        }
      }

      // 6. Audit Log (2026 Admin Traceability)
      const isSystem = source === ViolationSource.SYSTEM;
      await this.auditLogs.logAction({
        action: isSystem ? 'AUTO_CREATE' : 'CREATE',
        entity: 'VIOLATION',
        actorId: issuerId ?? undefined,
        actorType: isSystem ? 'SYSTEM' : 'ADMIN',
        actorName: isSystem ? `Scheduler:${vType.code ?? vType.nameEn}` : undefined,
        reason: dto.adminNotes || `Issued violation ${violation.id} to user ${targetUserId}`,
        metadata: { violationId: violation.id, points, fineAmount, source, code: vType.code },
      }, itx);

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
      const adminTitleAr = isSystem ? 'مخالفة تلقائية مُسجَّلة 🛡️' : 'تم تسجيل مخالفة 🛡️';
      const adminTitleEn = isSystem ? 'Auto-Issued Violation 🛡️' : 'Violation Issued 🛡️';
      const adminMsgAr = isSystem
        ? `قام النظام تلقائياً بتسجيل مخالفة (${vType.nameAr}) للمستخدم. يمكنك مراجعة المخالفة والتراجع عنها لو كانت غير صحيحة.`
        : `قام أدمن بتسجيل مخالفة (${vType.nameAr}) بحق المستخدم ${targetUserId}. النقاط: ${points}.`;
      const adminMsgEn = isSystem
        ? `System auto-issued violation (${vType.nameEn}). Review and dismiss if false-positive.`
        : `Admin issued violation (${vType.nameEn}) to user ${targetUserId}. Points: ${points}.`;
      await this.notifications.notifyAdmins({
        titleAr: adminTitleAr,
        titleEn: adminTitleEn,
        messageAr: adminMsgAr,
        messageEn: adminMsgEn,
        type: 'VIOLATION',
        link: '/dashboard/violations',
        metadata: { violationId: violation.id, targetUserId, source, code: vType.code }
      });

      // 8. Check for Penalties
      await this.checkAndTriggerPenalty(targetUserId, targetType, newScore, targetStoreId, itx);

      // 9. Loyalty Review prompt for SEVERE violations flagged with CANCEL_ALL_REWARDS_PROMPT
      if (vType.loyaltyImpact === LoyaltyImpact.CANCEL_ALL_REWARDS_PROMPT) {
        await this.createLoyaltyReviewAlert(
          {
            userId: targetUserId,
            triggeredByType: LoyaltyReviewTrigger.VIOLATION,
            triggeredById: violation.id,
            reasonAr: `مخالفة جسيمة: ${vType.nameAr}`,
            reasonEn: `Severe violation: ${vType.nameEn}`,
            metadata: { violationId: violation.id, code: vType.code, points, orderId: dto.orderId },
          },
          itx,
        );
      }

      return violation;
    };

    if (tx) {
      return logic(tx);
    }
    const created = await this.prisma.$transaction(logic);
    if (targetType === ViolationTargetType.MERCHANT && targetStoreId) {
      await this.merchantPerformance.recalculateAndPersist(targetStoreId);
    }
    return created;
  }

  // --- CUSTOMER RISK ALERTS (2026) ---

  async getRiskAlerts(status?: string) {
    return this.prisma.customerRiskAlert.findMany({
      where: status ? { status } : {},
      include: {
        user: {
          select: { 
            id: true, 
            name: true, 
            email: true, 
            phone: true, 
            avatar: true,
            totalDeliveredOrders: true,
            totalReturnDisputeOrders: true,
            cachedReturnRate: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async resolveRiskAlert(alertId: string, dto: ResolveRiskAlertDto, adminId: string) {
    const alert = await this.prisma.customerRiskAlert.findUnique({
      where: { id: alertId },
      include: { user: true }
    });

    if (!alert) throw new NotFoundException('Risk alert not found');
    if (alert.status !== 'PENDING_REVIEW') {
      throw new BadRequestException('Alert has already been resolved');
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Update Alert Status
      const updatedAlert = await tx.customerRiskAlert.update({
        where: { id: alertId },
        data: {
          status: dto.resolution,
          adminNotes: dto.adminNotes,
          reviewedBy: adminId,
          reviewedAt: new Date(),
          updatedAt: new Date()
        }
      });

      // 2. If resolution is VIOLATION_ISSUED, trigger the violation issuance
      if (dto.resolution === 'VIOLATION_ISSUED') {
        const vType = await tx.violationType.findFirst({
          where: { nameEn: 'Exceeded Allowed Return Rate' }
        });

        if (!vType) {
          throw new BadRequestException('Violation type "Exceeded Allowed Return Rate" not found in database.');
        }

        await this.issueViolation({
          typeId: vType.id,
          targetUserId: alert.userId,
          targetType: 'CUSTOMER',
          adminNotes: `Administrative resolution of Risk Alert: ${dto.adminNotes || 'High return rate confirmed.'}`
        }, adminId, tx);
      } else {
        // If DISMISSED, notify user
        await this.notifications.create({
          recipientId: alert.userId,
          recipientRole: 'CUSTOMER',
          type: 'SYSTEM',
          titleAr: '✅ تحديث بخصوص مراجعة الحساب',
          titleEn: '✅ Account Review Update',
          messageAr: 'تمت مراجعة نشاط حسابك، وحسابك الآن في وضع سليم. شكراً لالتزامك.',
          messageEn: 'Your account review was successful, and your account is in good standing.',
          link: '/dashboard'
        });
      }

      return updatedAlert;
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

    const merchantStoreId =
      appeal.violation.targetType === ViolationTargetType.MERCHANT
        ? appeal.violation.targetStoreId
        : null;

    const updated = await this.prisma.$transaction(async (tx) => {
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

    if (dto.status === 'APPROVED' && merchantStoreId) {
      await this.merchantPerformance.recalculateAndPersist(merchantStoreId);
    }

    return updated;
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

  // =====================================================================
  // 2026 AUTO-ISSUE PIPELINE
  // Called by schedulers / order-cleanup / returns / dispute verdict
  // - Resolves type by stable `code` (cached)
  // - Idempotent via `unique_key` (one violation per code+order+target)
  // - Never throws into the caller's flow (failures are logged)
  // =====================================================================
  async autoIssue(input: AutoIssueInput): Promise<any | null> {
    try {
      const vType = await this.resolveTypeByCode(input.code);
      if (!vType) {
        this.logger.warn(`[autoIssue] No ViolationType found for code "${input.code}"; skipping.`);
        return null;
      }
      if (!vType.isActive) {
        this.logger.debug(`[autoIssue] ViolationType "${input.code}" is inactive; skipping.`);
        return null;
      }
      if (vType.targetType !== input.targetType) {
        this.logger.warn(
          `[autoIssue] targetType mismatch for "${input.code}" — expected ${vType.targetType} got ${input.targetType}; skipping.`,
        );
        return null;
      }

      // Validate target user exists (prevent orphan rows)
      const userExists = await this.prisma.user.findUnique({
        where: { id: input.targetUserId },
        select: { id: true },
      });
      if (!userExists) {
        this.logger.warn(`[autoIssue] target user ${input.targetUserId} not found; skipping.`);
        return null;
      }

      const orderPart = input.orderId ?? 'no-order';
      const suffix = input.dedupSuffix ? `:${input.dedupSuffix}` : '';
      const uniqueKey = `${input.code}:${orderPart}:${input.targetUserId}${suffix}`;

      const violation = await this.issueViolation(
        {
          typeId: vType.id,
          targetUserId: input.targetUserId,
          targetStoreId: input.targetStoreId ?? undefined,
          targetType: input.targetType,
          orderId: input.orderId ?? undefined,
          adminNotes: input.reason || `Auto-issued by system (${input.code})`,
          source: ViolationSource.SYSTEM,
          uniqueKey,
        },
        null,
      );

      this.logger.log(
        `[autoIssue] OK code=${input.code} target=${input.targetType}:${input.targetUserId} order=${input.orderId ?? '-'}`,
      );
      return violation;
    } catch (err) {
      // Never break the caller's pipeline; log loudly so ops can investigate.
      this.logger.error(
        `[autoIssue] Failed for code=${input.code} target=${input.targetUserId}: ${err?.message || err}`,
        err?.stack,
      );
      return null;
    }
  }

  // =====================================================================
  // LOYALTY REVIEW ALERTS (admin-gated rewards cancellation)
  // =====================================================================
  async createLoyaltyReviewAlert(
    input: {
      userId: string;
      triggeredByType: LoyaltyReviewTrigger;
      triggeredById?: string;
      reasonAr: string;
      reasonEn: string;
      metadata?: Record<string, any>;
    },
    tx?: any,
  ) {
    const db = tx || this.prisma;
    // Dedup: don't create another PENDING_REVIEW alert for the same trigger
    if (input.triggeredById) {
      const existing = await db.loyaltyReviewAlert.findFirst({
        where: {
          userId: input.userId,
          triggeredByType: input.triggeredByType,
          triggeredById: input.triggeredById,
          status: LoyaltyReviewStatus.PENDING_REVIEW,
        },
      });
      if (existing) return existing;
    }

    const alert = await db.loyaltyReviewAlert.create({
      data: {
        userId: input.userId,
        triggeredByType: input.triggeredByType,
        triggeredById: input.triggeredById,
        reasonAr: input.reasonAr,
        reasonEn: input.reasonEn,
        metadata: input.metadata || {},
      },
    });

    await this.notifications.notifyAdmins({
      titleAr: 'مراجعة ولاء مطلوبة ⚠️',
      titleEn: 'Loyalty Review Required ⚠️',
      messageAr: `طلب من الإدارة قرار بشأن إلغاء مكافآت الولاء بسبب: ${input.reasonAr}.`,
      messageEn: `Admin decision needed on loyalty rewards cancellation. Reason: ${input.reasonEn}.`,
      type: 'LOYALTY_REVIEW',
      link: '/dashboard/violations',
      metadata: { alertId: alert.id, userId: input.userId, triggeredByType: input.triggeredByType },
    });

    await this.auditLogs.logAction(
      {
        action: 'CREATE',
        entity: 'LOYALTY_REVIEW_ALERT',
        actorType: 'SYSTEM',
        actorName: 'Scheduler:LoyaltyReview',
        reason: input.reasonEn,
        metadata: { alertId: alert.id, userId: input.userId, triggeredByType: input.triggeredByType, triggeredById: input.triggeredById },
      },
      tx,
    );

    return alert;
  }

  async getLoyaltyReviewAlerts(status?: LoyaltyReviewStatus) {
    return this.prisma.loyaltyReviewAlert.findMany({
      where: status ? { status } : {},
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            avatar: true,
            loyaltyTier: true,
            loyaltyPoints: true,
            customerBalance: true,
            violationScore: true,
          },
        },
        decider: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async decideLoyaltyAlert(
    alertId: string,
    decision: 'CANCEL_REWARDS' | 'KEEP_REWARDS',
    adminId: string,
    adminNotes?: string,
  ) {
    const alert = await this.prisma.loyaltyReviewAlert.findUnique({
      where: { id: alertId },
      include: { user: { select: { id: true, loyaltyTier: true, loyaltyPoints: true } } },
    });
    if (!alert) throw new NotFoundException('Loyalty review alert not found');
    if (alert.status !== LoyaltyReviewStatus.PENDING_REVIEW) {
      throw new BadRequestException('Alert has already been decided');
    }

    if (decision === 'CANCEL_REWARDS') {
      await this.loyaltyService.cancelAllRewards(
        alert.userId,
        adminNotes || alert.reasonEn,
        adminId,
      );
    }

    const updated = await this.prisma.loyaltyReviewAlert.update({
      where: { id: alertId },
      data: {
        status:
          decision === 'CANCEL_REWARDS'
            ? LoyaltyReviewStatus.REWARDS_CANCELLED
            : LoyaltyReviewStatus.KEPT,
        decidedBy: adminId,
        decidedAt: new Date(),
        adminNotes,
      },
    });

    await this.auditLogs.logAction({
      action: 'DECIDE',
      entity: 'LOYALTY_REVIEW_ALERT',
      actorType: 'ADMIN',
      actorId: adminId,
      reason: adminNotes || decision,
      metadata: {
        alertId,
        userId: alert.userId,
        decision,
        previousTier: alert.user?.loyaltyTier,
        previousPoints: alert.user?.loyaltyPoints,
      },
    });

    // Notify the user about the decision (transparency)
    await this.notifications.create({
      recipientId: alert.userId,
      recipientRole: 'CUSTOMER',
      type: 'LOYALTY',
      titleAr: decision === 'CANCEL_REWARDS' ? 'تم إلغاء مكافآت الولاء' : 'تم الإبقاء على مكافآت الولاء',
      titleEn: decision === 'CANCEL_REWARDS' ? 'Loyalty Rewards Cancelled' : 'Loyalty Rewards Kept',
      messageAr:
        decision === 'CANCEL_REWARDS'
          ? `بناءً على المراجعة الإدارية، تم تصفير نقاط ولاءك وإرجاع مستواك إلى BASIC.`
          : `تمت مراجعة حالتك وتم الإبقاء على مكافآت الولاء بدون تغيير.`,
      messageEn:
        decision === 'CANCEL_REWARDS'
          ? `Following admin review, your loyalty points were reset and tier returned to BASIC.`
          : `Your case was reviewed and loyalty rewards were kept unchanged.`,
      link: '/dashboard/wallet',
      metadata: { alertId, decision },
    });

    return updated;
  }

  // =====================================================================
  // ADMIN: Direct Drop a Violation (without waiting for an appeal)
  // =====================================================================
  async dropViolation(violationId: string, adminId: string, reason: string) {
    const violation = await this.prisma.violation.findUnique({
      where: { id: violationId },
      include: { type: true },
    });
    if (!violation) throw new NotFoundException('Violation not found');
    if (violation.status === ViolationStatus.DROPPED) {
      throw new BadRequestException('Violation already dropped');
    }
    if (violation.status === ViolationStatus.DECAYED) {
      throw new BadRequestException('Violation already decayed; nothing to drop');
    }

    const merchantStoreId =
      violation.targetType === ViolationTargetType.MERCHANT ? violation.targetStoreId : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: violation.targetUserId },
        select: { violationScore: true },
      });
      const previousScore = user?.violationScore ?? 0;
      const pointsToRestore = violation.points;
      const newScore = Math.max(0, previousScore - pointsToRestore);

      await tx.user.update({
        where: { id: violation.targetUserId },
        data: { violationScore: newScore },
      });

      const result = await tx.violation.update({
        where: { id: violationId },
        data: { status: ViolationStatus.DROPPED },
      });

      await tx.violationScoreLog.create({
        data: {
          targetUserId: violation.targetUserId,
          targetType: violation.targetType,
          previousScore,
          newScore,
          changeAmount: -pointsToRestore,
          reason: `Admin drop: ${reason}`,
          violationId: violation.id,
        },
      });

      await this.auditLogs.logAction(
        {
          action: 'DROP',
          entity: 'VIOLATION',
          actorType: 'ADMIN',
          actorId: adminId,
          reason,
          metadata: { violationId, restoredPoints: pointsToRestore, code: violation.type.code },
        },
        tx,
      );

      return result;
    });

    await this.notifications.create({
      recipientId: violation.targetUserId,
      recipientRole: violation.targetType === 'MERCHANT' ? 'VENDOR' : 'CUSTOMER',
      type: 'VIOLATION',
      titleAr: 'تم إسقاط مخالفة بحقك ✅',
      titleEn: 'Violation Dropped by Admin ✅',
      messageAr: `تم إسقاط المخالفة "${violation.type.nameAr}" واستعادة ${violation.points} نقطة. السبب: ${reason}`,
      messageEn: `Violation "${violation.type.nameEn}" was dropped and ${violation.points} points were restored. Reason: ${reason}`,
      link: '/dashboard/violations',
      metadata: { violationId, restoredPoints: violation.points },
    });

    if (merchantStoreId) {
      await this.merchantPerformance.recalculateAndPersist(merchantStoreId);
    }

    return updated;
  }
}
