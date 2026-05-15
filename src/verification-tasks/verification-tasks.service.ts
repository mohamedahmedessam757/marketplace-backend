import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { StartVerificationDto } from './dto/start-verification.dto';
import { CompleteVerificationDto } from './dto/complete-verification.dto';
import { ActorType, OrderStatus, Prisma, UserRole, UserStatus } from '@prisma/client';
import * as crypto from 'crypto';

const TERMINAL_TASK_STATUSES = ['ADMIN_APPROVED', 'ADMIN_REJECTED', 'CANCELLED'] as const;

@Injectable()
export class VerificationTasksService {
  private readonly logger = new Logger(VerificationTasksService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private auditLogs: AuditLogsService,
  ) {}

  async assignTask(dto: CreateTaskDto, adminId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: dto.orderId } });
    if (!order) throw new NotFoundException('Order not found');

    const openTask = await this.prisma.verificationTask.findFirst({
      where: {
        orderId: dto.orderId,
        status: { notIn: [...TERMINAL_TASK_STATUSES, 'CANCELLED'] },
      },
      orderBy: { cycleNumber: 'desc' },
    });

    const result = await this.prisma.$transaction(async (tx) => {
      if (openTask) {
        const task = await tx.verificationTask.update({
          where: { id: openTask.id },
          data: {
            officerId: dto.officerId ?? openTask.officerId,
            assignedById: adminId,
            status: dto.officerId ? 'ASSIGNED' : openTask.status,
            assignedAt: dto.officerId ? new Date() : openTask.assignedAt,
          },
        });
        await tx.order.update({
          where: { id: dto.orderId },
          data: { verificationTaskId: task.id },
        });
        if (dto.officerId) {
          await tx.verificationActivityLog.create({
            data: {
              taskId: task.id,
              officerId: dto.officerId,
              action: 'TASK_ASSIGNED',
            },
          });
        }
        return task;
      }

      const task = await tx.verificationTask.create({
        data: {
          orderId: dto.orderId,
          officerId: dto.officerId,
          assignedById: adminId,
          status: dto.officerId ? 'ASSIGNED' : 'PENDING_ASSIGNMENT',
          assignedAt: dto.officerId ? new Date() : null,
        },
      });

      await tx.order.update({
        where: { id: dto.orderId },
        data: { verificationTaskId: task.id },
      });

      await tx.verificationActivityLog.create({
        data: {
          taskId: task.id,
          officerId: dto.officerId,
          action: dto.officerId ? 'TASK_ASSIGNED' : 'TASK_CREATED',
        },
      });

      return task;
    });

    if (dto.officerId) {
      await this.notifications.notifyUser(dto.officerId, 'VERIFICATION_OFFICER', {
        titleAr: 'مهمة مطابقة جديدة',
        titleEn: 'New Verification Task',
        messageAr: `تم إسناد مهمة مطابقة جديدة للطلب #${order.orderNumber} إليك.`,
        messageEn: `A new verification task for Order #${order.orderNumber} has been assigned to you.`,
        type: 'system',
        link: `/admin/verification-tasks/${result.id}`
      });
    }

    return result;
  }

  async generateLink(taskId: string, adminId: string, durationHours: number = 24) {
    const task = await this.prisma.verificationTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found');

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + durationHours);

    const result = await this.prisma.$transaction(async (tx) => {
      // Expire previous active links for this task
      await tx.verificationLink.updateMany({
        where: { taskId, isActive: true },
        data: { isActive: false }
      });

      const link = await tx.verificationLink.create({
        data: {
          taskId,
          token,
          expiresAt,
          maxDurationHours: durationHours,
          createdById: adminId,
          qrCodeData: `vlink:${token}`, // A format the frontend can easily read
        }
      });

      await tx.verificationActivityLog.create({
        data: {
          taskId,
          action: 'LINK_GENERATED',
          metadata: { tokenId: link.id, expiresAt }
        }
      });
      
      // Also update task status if it wasn't started
      if (task.status === 'ASSIGNED' || task.status === 'PENDING_ASSIGNMENT') {
        await tx.verificationTask.update({
            where: { id: taskId },
            data: { status: 'LINK_SENT' }
        });
      }

      return link;
    });

    const verifyUrl = process.env.FRONTEND_URL
      ? `${process.env.FRONTEND_URL.replace(/\/$/, '')}/verify/${result.token}`
      : undefined;

    return { ...result, verifyUrl, qrCodeData: result.qrCodeData };
  }

  private async findLinkOrThrow(token: string) {
    const link = await this.prisma.verificationLink.findUnique({
      where: { token },
      include: { task: { include: { order: { select: { orderNumber: true, status: true } } } } },
    });
    if (!link) throw new NotFoundException('Invalid link');
    if (!link.isActive) throw new BadRequestException('Link has been deactivated');
    if (new Date() > link.expiresAt) throw new BadRequestException('Link has expired');
    if (TERMINAL_TASK_STATUSES.includes(link.task.status as typeof TERMINAL_TASK_STATUSES[number])) {
      throw new BadRequestException('Task is already closed');
    }
    return link;
  }

  async validatePublicLink(token: string) {
    const link = await this.findLinkOrThrow(token);

    if (!link.openedAt) {
      await this.prisma.$transaction(async (tx) => {
        await tx.verificationLink.update({
          where: { id: link.id },
          data: { openedAt: new Date() },
        });
        await tx.verificationActivityLog.create({
          data: { taskId: link.taskId, action: 'LINK_OPENED', metadata: { token: link.id } },
        });
      });
    }

    return {
      taskId: link.taskId,
      orderNumber: link.task.order?.orderNumber,
      expiresAt: link.expiresAt,
      taskStatus: link.task.status,
    };
  }

  async activateLink(
    token: string,
    officerId: string,
    meta?: { lat?: number; lng?: number; deviceInfo?: Record<string, unknown> },
  ) {
    const link = await this.findLinkOrThrow(token);

    if (link.task.officerId && link.task.officerId !== officerId) {
      throw new ForbiddenException('Task is assigned to another officer');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.verificationLink.update({
        where: { id: link.id },
        data: {
          openedAt: link.openedAt ?? new Date(),
          otpVerifiedAt: new Date(),
          deviceInfo: (meta?.deviceInfo ?? link.deviceInfo) as Prisma.InputJsonValue,
          gpsLat: meta?.lat ?? link.gpsLat,
          gpsLng: meta?.lng ?? link.gpsLng,
        },
      });

      if (!link.task.officerId) {
        await tx.verificationTask.update({
          where: { id: link.taskId },
          data: { officerId, status: 'ASSIGNED', assignedAt: new Date() },
        });
      }

      await tx.verificationActivityLog.create({
        data: {
          taskId: link.taskId,
          officerId,
          action: 'OTP_VERIFIED',
          gpsLat: meta?.lat,
          gpsLng: meta?.lng,
          deviceInfo: meta?.deviceInfo as Prisma.InputJsonValue | undefined,
        },
      });
    });

    await this.notifications.notifyUser(officerId, 'VERIFICATION_OFFICER', {
      titleAr: 'تم تفعيل رابط المطابقة',
      titleEn: 'Verification link activated',
      messageAr: `يمكنك الآن بدء مهمة المطابقة للطلب #${link.task.order?.orderNumber}.`,
      messageEn: `You can now start verification for order #${link.task.order?.orderNumber}.`,
      type: 'system',
      link: `/dashboard/verification-task-details/${link.taskId}`,
    });

    return { success: true, taskId: link.taskId };
  }

  /** @deprecated Use activateLink — kept for backward compatibility */
  async verifyLink(token: string, officerId: string) {
    return this.activateLink(token, officerId);
  }

  async listOfficers() {
    return this.prisma.user.findMany({
      where: { role: UserRole.VERIFICATION_OFFICER, status: UserStatus.ACTIVE },
      select: { id: true, name: true, email: true, phone: true },
      orderBy: { name: 'asc' },
    });
  }

  async deactivateTaskLinks(taskId: string) {
    await this.prisma.verificationLink.updateMany({
      where: { taskId, isActive: true },
      data: { isActive: false },
    });
  }

  private async buildVerificationReport(taskId: string): Promise<string> {
    const task = await this.prisma.verificationTask.findUnique({
      where: { id: taskId },
      include: {
        order: { select: { orderNumber: true, partName: true } },
        officer: { select: { name: true, email: true } },
      },
    });
    if (!task) return '';

    const html = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"/><title>تقرير مطابقة ${task.order?.orderNumber}</title>
<style>body{font-family:Arial,sans-serif;padding:24px;color:#111}h1{color:#b8860b}.meta{margin:12px 0}</style></head><body>
<h1>تقرير مطابقة ميدانية</h1>
<p class="meta"><strong>الطلب:</strong> #${task.order?.orderNumber ?? '—'}</p>
<p class="meta"><strong>القطعة:</strong> ${task.order?.partName ?? '—'}</p>
<p class="meta"><strong>الموظف:</strong> ${task.officer?.name ?? '—'} (${task.officer?.email ?? ''})</p>
<p class="meta"><strong>القرار:</strong> ${task.decision === 'MATCHING' ? 'مطابق' : task.decision === 'NON_MATCHING' ? 'غير مطابق' : '—'}</p>
<p class="meta"><strong>السبب:</strong> ${task.decisionReason ?? '—'}</p>
<p class="meta"><strong>ملاحظات:</strong> ${task.officerNotes ?? '—'}</p>
<p class="meta"><strong>بدء:</strong> ${task.startedAt?.toISOString() ?? '—'}</p>
<p class="meta"><strong>انتهاء:</strong> ${task.completedAt?.toISOString() ?? '—'}</p>
<p class="meta"><strong>GPS بداية:</strong> ${task.startLat ?? '—'}, ${task.startLng ?? '—'}</p>
<p class="meta"><strong>GPS نهاية:</strong> ${task.endLat ?? '—'}, ${task.endLng ?? '—'}</p>
</body></html>`;

    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  }

  async getMyTasks(officerId: string) {
    return this.prisma.verificationTask.findMany({
      where: { officerId },
      include: {
        order: {
          select: { orderNumber: true, partName: true, vehicleMake: true, vehicleModel: true, vehicleYear: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async getTasksByOrder(orderId: string) {
    return this.prisma.verificationTask.findMany({
      where: { orderId },
      include: {
        officer: { select: { id: true, name: true, email: true } },
        links: { orderBy: { createdAt: 'desc' } }
      },
      orderBy: { cycleNumber: 'desc' }
    });
  }

  async getTaskDetails(taskId: string) {
    const task = await this.prisma.verificationTask.findUnique({
      where: { id: taskId },
      include: {
        order: {
          include: {
            customer: true,
            store: true,
            parts: true,
            verificationDocuments: { orderBy: { createdAt: 'desc' }, take: 1 }
          }
        },
        links: { where: { isActive: true } },
        activityLogs: { orderBy: { createdAt: 'desc' } }
      }
    });
    
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  async uploadPhotos(taskId: string, officerId: string, photos: string[], lat?: number, lng?: number) {
    const task = await this.prisma.verificationTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found');
    if (task.officerId !== officerId) throw new ForbiddenException('Not your assigned task');
    if (task.status !== 'IN_PROGRESS') throw new BadRequestException('Task must be in progress');

    const currentPhotos = (task.officerPhotos as string[]) || [];
    const updatedPhotos = [...currentPhotos, ...photos];

    await this.prisma.$transaction(async (tx) => {
      await tx.verificationTask.update({
        where: { id: taskId },
        data: { officerPhotos: updatedPhotos }
      });

      await tx.verificationActivityLog.create({
        data: {
          taskId,
          officerId,
          action: 'PHOTO_UPLOADED',
          gpsLat: lat,
          gpsLng: lng,
          metadata: { photosCount: photos.length }
        }
      });
    });

    return { success: true, photos: updatedPhotos };
  }

  async getActivityLog(taskId: string) {
    return this.prisma.verificationActivityLog.findMany({
      where: { taskId },
      include: {
        officer: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async startVerification(taskId: string, officerId: string, dto: StartVerificationDto) {
    const task = await this.prisma.verificationTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found');
    if (task.officerId !== officerId) throw new ForbiddenException('Not your assigned task');
    if (task.status !== 'ASSIGNED' && task.status !== 'LINK_SENT') {
        throw new BadRequestException('Task is not in a startable state');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.verificationTask.update({
        where: { id: taskId },
        data: {
          status: 'IN_PROGRESS',
          startedAt: new Date(),
          startLat: dto.lat,
          startLng: dto.lng,
          startDeviceInfo: dto.deviceInfo,
        }
      });

      await tx.verificationActivityLog.create({
        data: {
          taskId,
          officerId,
          action: 'VERIFICATION_STARTED',
          gpsLat: dto.lat,
          gpsLng: dto.lng,
          deviceInfo: dto.deviceInfo
        }
      });
    });

    return { success: true };
  }

  async completeVerification(taskId: string, officerId: string, dto: CompleteVerificationDto & { lat?: number, lng?: number, deviceInfo?: any }) {
    const task = await this.prisma.verificationTask.findUnique({ 
        where: { id: taskId },
        include: { order: { include: { verificationDocuments: { orderBy: { createdAt: 'desc' }, take: 1 } } } } 
    });
    if (!task) throw new NotFoundException('Task not found');
    if (task.officerId !== officerId && task.officerId !== null) {
        throw new ForbiddenException('Not your assigned task');
    }
    if (task.status !== 'IN_PROGRESS') {
        throw new BadRequestException('Task must be started first');
    }

    if (dto.decision === 'NON_MATCHING' && !dto.reason?.trim()) {
      throw new BadRequestException('Rejection reason is required for non-matching decision');
    }
    if (!dto.photos?.length && !(Array.isArray(task.officerPhotos) && (task.officerPhotos as string[]).length)) {
      throw new BadRequestException('At least one verification photo is required');
    }

    const taskStatus =
      dto.decision === 'MATCHING' ? 'AWAITING_ADMIN_APPROVAL' : 'AWAITING_CORRECTION';

    await this.prisma.$transaction(async (tx) => {
        await tx.verificationTask.update({
            where: { id: taskId },
            data: {
                status: taskStatus,
                completedAt: new Date(),
                decision: dto.decision,
                decisionReason: dto.reason,
                officerPhotos: dto.photos && dto.photos.length > 0 ? dto.photos : task.officerPhotos,
                officerNotes: dto.notes,
                endLat: dto.lat,
                endLng: dto.lng,
                endDeviceInfo: dto.deviceInfo as Prisma.InputJsonValue | undefined,
            }
        });

        if (dto.decision === 'NON_MATCHING') {
          const correctionDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000);
          await tx.order.update({
            where: { id: task.orderId },
            data: {
              status: OrderStatus.CORRECTION_PERIOD,
              correctionDeadlineAt: correctionDeadline,
            },
          });
        }

        await tx.verificationActivityLog.create({
            data: {
                taskId,
                officerId,
                action: dto.decision === 'MATCHING' ? 'DECISION_MATCHING' : 'DECISION_NON_MATCHING',
                gpsLat: dto.lat,
                gpsLng: dto.lng,
                deviceInfo: dto.deviceInfo as Prisma.InputJsonValue | undefined,
                metadata: { reason: dto.reason }
            }
        });

    });

    const reportUrl = await this.buildVerificationReport(taskId);
    await this.prisma.verificationTask.update({
      where: { id: taskId },
      data: { reportUrl },
    });
    await this.prisma.verificationActivityLog.create({
      data: { taskId, officerId, action: 'REPORT_GENERATED', metadata: { reportUrl } },
    });

    await this.deactivateTaskLinks(taskId);

    // Notify Admins
    await this.notifications.notifyAdmins({
        titleAr: dto.decision === 'MATCHING' ? 'مطابقة ناجحة تحتاج الاعتماد' : 'تم اكتشاف قطعة غير مطابقة',
        titleEn: dto.decision === 'MATCHING' ? 'Matching Successful - Needs Approval' : 'Non-matching Part Detected',
        messageAr: `قام موظف المطابقة بإنهاء المهمة للطلب #${task.order.orderNumber} بقرار: ${dto.decision === 'MATCHING' ? 'مطابق' : 'غير مطابق'}`,
        messageEn: `Verification Officer completed task for Order #${task.order.orderNumber} with decision: ${dto.decision}`,
        type: 'system',
        link: `/admin/orders/${task.order.id}`
    });

    const storeId = task.order.verificationDocuments?.[0]?.storeId;
    if (storeId) {
        try {
            if (dto.decision === 'NON_MATCHING') {
              await this.notifications.notifyMerchantByStoreId(storeId, {
                titleAr: '⚠️ غير مطابق — مطلوب تصحيح خلال 48 ساعة',
                titleEn: '⚠️ Non-matching — 48h correction required',
                messageAr: `أبلغ موظف المطابقة بعدم مطابقة الطلب #${task.order.orderNumber}. لديك 48 ساعة لتصحيح الطلب وإعادة الإرسال.`,
                messageEn: `Field officer reported non-match for order #${task.order.orderNumber}. You have 48 hours to correct and resubmit.`,
                type: 'system_alert',
                link: `/merchant/orders/${task.order.id}`,
              });
            } else {
              await this.notifications.notifyMerchantByStoreId(storeId, {
                titleAr: 'تحديث في حالة المطابقة',
                titleEn: 'Verification Status Update',
                messageAr: `أنهى موظف المطابقة فحص الطلب #${task.order.orderNumber} بنتيجة مطابق — بانتظار اعتماد الإدارة.`,
                messageEn: `Field officer completed inspection for order #${task.order.orderNumber} as matching — pending admin approval.`,
                type: 'system_alert',
                link: `/merchant/orders/${task.order.id}`,
              });
            }
        } catch (e) {
            this.logger.warn(`Failed to notify merchant for task ${taskId}: ${e.message}`);
        }
    }

    return { success: true, decisionStatus: taskStatus, reportUrl };
  }
}
