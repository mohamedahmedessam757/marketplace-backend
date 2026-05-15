import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { StartVerificationDto } from './dto/start-verification.dto';
import { CompleteVerificationDto } from './dto/complete-verification.dto';
import { AdminFieldReviewDto } from './dto/admin-field-review.dto';
import { ActorType, OrderStatus, Prisma, UserRole, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertVerificationTaskAccess } from './verification-task-access';
import { UploadsService, VERIFICATION_FIELD_PHOTOS_BUCKET } from '../uploads/uploads.service';
import * as crypto from 'crypto';

/** Narrow delegate for `VerificationTaskPhoto` (editor/Prisma client shapes can desync until `npx prisma generate`). */
type VerificationTaskPhotoRepo = {
  findMany(args: {
    where: { taskId: string };
    orderBy: Array<{ sortOrder?: 'asc' | 'desc'; createdAt?: 'asc' | 'desc' }>;
    select: { url: true };
  }): Promise<Array<{ url: string }>>;
  count(args: { where: { taskId: string } }): Promise<number>;
  create(args: {
    data: {
      taskId: string;
      officerId: string;
      url: string;
      storagePath: string;
      contentType: string | null;
      sortOrder: number;
    };
  }): Promise<unknown>;
};

const TERMINAL_TASK_STATUSES = ['ADMIN_APPROVED', 'ADMIN_REJECTED', 'CANCELLED'] as const;

const VERIFICATION_ORDER_INCLUDE = {
  customer: { select: { id: true, name: true, email: true, phone: true } },
  store: { select: { id: true, name: true, storeCode: true, logo: true } },
  parts: { orderBy: { createdAt: 'asc' as const } },
  verificationDocuments: {
    orderBy: { createdAt: 'desc' as const },
    include: {
      store: { select: { id: true, name: true, storeCode: true, logo: true } },
    },
  },
  invoices: {
    orderBy: { issuedAt: 'desc' as const },
    take: 30,
    select: {
      id: true,
      invoiceNumber: true,
      total: true,
      subtotal: true,
      shipping: true,
      commission: true,
      currency: true,
      status: true,
      issuedAt: true,
    },
  },
  acceptedOffer: {
    select: {
      id: true,
      offerNumber: true,
      condition: true,
      partType: true,
      notes: true,
      unitPrice: true,
      offerImage: true,
    },
  },
} satisfies Prisma.OrderInclude;

/** Ensures `fieldPhotos` is recognized even if the editor’s Prisma types lag behind `npx prisma generate`. */
type VerificationTaskDetailsInclude = Prisma.VerificationTaskInclude & {
  fieldPhotos: {
    orderBy: Array<{ sortOrder?: 'asc' | 'desc'; createdAt?: 'asc' | 'desc' }>;
  };
};

const VERIFICATION_TASK_DETAILS_INCLUDE = {
  officer: { select: { id: true, name: true, email: true, phone: true } },
  assignedBy: { select: { id: true, name: true } },
  order: { include: VERIFICATION_ORDER_INCLUDE },
  links: { orderBy: { createdAt: 'desc' as const } },
  fieldPhotos: { orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }] },
  activityLogs: {
    orderBy: { createdAt: 'desc' as const },
    take: 100,
    include: { officer: { select: { id: true, name: true, email: true } } },
  },
} satisfies VerificationTaskDetailsInclude;

@Injectable()
export class VerificationTasksService {
  private readonly logger = new Logger(VerificationTasksService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private auditLogs: AuditLogsService,
    private uploads: UploadsService,
  ) {}

  private get verificationTaskPhotoRows(): VerificationTaskPhotoRepo {
    const rows = (this.prisma as unknown as { verificationTaskPhoto?: VerificationTaskPhotoRepo }).verificationTaskPhoto;
    if (!rows) {
      throw new Error(
        'Prisma client is missing verificationTaskPhoto. Run `npx prisma generate` in the backend folder.',
      );
    }
    return rows;
  }

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
      include: {
        task: {
          select: {
            id: true,
            status: true,
            startedAt: true,
            officerId: true,
            order: { select: { orderNumber: true, status: true } },
          },
        },
      },
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

    const activeLink = link;
    const sessionDeadline = this.computeSessionDeadline(
      activeLink.expiresAt,
      activeLink.maxDurationHours,
      link.task.startedAt,
    );

    return {
      taskId: link.taskId,
      orderNumber: link.task.order?.orderNumber,
      expiresAt: link.expiresAt,
      sessionDeadline,
      maxDurationHours: link.maxDurationHours,
      taskStatus: link.task.status,
    };
  }

  /** Earliest deadline: link expiry or (start + maxDurationHours) when inspection started. */
  computeSessionDeadline(
    linkExpiresAt: Date,
    maxDurationHours: number,
    startedAt?: Date | null,
  ): Date {
    const candidates = [new Date(linkExpiresAt)];
    if (startedAt) {
      const sessionEnd = new Date(startedAt);
      sessionEnd.setHours(sessionEnd.getHours() + maxDurationHours);
      candidates.push(sessionEnd);
    }
    return new Date(Math.min(...candidates.map((d) => d.getTime())));
  }

  private async loadTaskForAccess(taskId: string) {
    const task = await this.prisma.verificationTask.findUnique({
      where: { id: taskId },
      select: { id: true, officerId: true, orderId: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  private isHttpPhotoUrl(s: unknown): boolean {
    return typeof s === 'string' && /^https?:\/\//i.test(s) && !s.startsWith('data:');
  }

  /** Sync JSON column from `verification_task_photos` or legacy HTTP URLs only. */
  private async syncOfficerPhotosJsonFromTable(taskId: string): Promise<string[]> {
    const rows = await this.verificationTaskPhotoRows.findMany({
      where: { taskId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { url: true },
    });
    const fromTable = rows.map((r) => r.url);
    if (fromTable.length > 0) {
      await this.prisma.verificationTask.update({
        where: { id: taskId },
        data: { officerPhotos: fromTable },
      });
      return fromTable;
    }
    const task = await this.prisma.verificationTask.findUnique({
      where: { id: taskId },
      select: { officerPhotos: true },
    });
    return ((task?.officerPhotos as string[]) || []).filter((u) => this.isHttpPhotoUrl(u));
  }

  async uploadFieldPhotosToStorage(taskId: string, officerId: string, files: Express.Multer.File[]) {
    const task = await this.prisma.verificationTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found');
    if (task.officerId !== officerId) throw new ForbiddenException('Not your assigned task');
    if (task.status !== 'IN_PROGRESS') throw new BadRequestException('Task must be in progress');
    if (!files?.length) throw new BadRequestException('No files uploaded');

    const existingCount = await this.verificationTaskPhotoRows.count({ where: { taskId } });

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const { url, storagePath } = await this.uploads.uploadVerificationFieldPhoto(file, taskId);
      await this.verificationTaskPhotoRows.create({
        data: {
          taskId,
          officerId,
          url,
          storagePath,
          contentType: file.mimetype ?? null,
          sortOrder: existingCount + i,
        },
      });
    }

    const allUrls = await this.syncOfficerPhotosJsonFromTable(taskId);

    await this.prisma.verificationActivityLog.create({
      data: {
        taskId,
        officerId,
        action: 'PHOTO_UPLOADED',
        metadata: {
          storage: 'supabase',
          bucket: VERIFICATION_FIELD_PHOTOS_BUCKET,
          count: files.length,
        },
      },
    });

    return { success: true, urls: allUrls };
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

  private escapeReportHtml(s: string | null | undefined): string {
    if (s == null || s === '') return '—';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Stable path stored in DB; actual HTML is served from GET :id/report */
  private verificationReportPath(taskId: string): string {
    return `/verification-tasks/${taskId}/report`;
  }

  private composeVerificationReportHtml(task: any): string {
    const isAr = true; // Defaulting to Arabic for this template as requested
    const order = task.order ?? {};
    const officer = task.officer ?? {};
    const store = order.store ?? {};
    const customer = order.customer ?? {};
    const photos = task.fieldPhotos ?? [];
    
    // Comparison Evidence
    const customerImages = this.getCustomerReferenceImages(order);
    const merchantDoc = order.verificationDocuments?.[0] ?? {};
    const merchantImages = this.asImageUrls(merchantDoc.images);
    
    const orderNumber = order.orderNumber ?? '—';
    const partName = order.partName ?? '—';
    const decision = task.decision;
    
    const decisionLabel = decision === 'MATCHING' 
      ? (isAr ? 'مطابق' : 'MATCHING') 
      : decision === 'NON_MATCHING' 
        ? (isAr ? 'غير مطابق' : 'NON-MATCHING') 
        : (isAr ? 'قيد الانتظار' : 'PENDING');
    
    const decisionClass = decision === 'MATCHING' ? 'status-success' : decision === 'NON_MATCHING' ? 'status-danger' : 'status-pending';

    // Premium 2026 CSS Design System
    const css = `
      @import url('https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Inter:wght@300;400;600;700&display=swap');
      
      :root {
        --gold-primary: #B8860B;
        --gold-light: #DAA520;
        --bg-dark: #1A1814;
        --text-main: #2D2D2D;
        --text-muted: #666666;
        --border-color: #EEEEEE;
        --card-bg: #FFFFFF;
      }

      * { box-sizing: border-box; }
      body { 
        font-family: 'Inter', 'Amiri', serif; 
        margin: 0; padding: 40px; 
        background: #F9F9F9; color: var(--text-main); 
        line-height: 1.6;
        direction: ${isAr ? 'rtl' : 'ltr'};
      }

      .report-container {
        max-width: 1000px;
        margin: 0 auto;
        background: var(--card-bg);
        padding: 60px;
        box-shadow: 0 20px 50px rgba(0,0,0,0.05);
        border-radius: 2px;
        position: relative;
        border-top: 8px solid var(--gold-primary);
      }

      header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 60px;
        border-bottom: 1px solid var(--border-color);
        padding-bottom: 30px;
      }

      .brand-info { display: flex; align-items: center; gap: 15px; }
      .brand-logo { width: 60px; height: 60px; background: var(--bg-dark); border-radius: 12px; display: flex; align-items: center; justify-content: center; overflow: hidden; border: 2px solid var(--gold-primary); }
      .brand-logo img { width: 85%; height: auto; object-fit: contain; }
      .brand-name { font-size: 24px; font-weight: 900; color: var(--bg-dark); letter-spacing: -1px; text-transform: uppercase; }

      .report-meta { text-align: ${isAr ? 'left' : 'right'}; }
      .report-title { font-size: 28px; font-weight: 800; color: var(--gold-primary); margin: 0; text-transform: uppercase; }
      .report-number { font-family: monospace; font-size: 14px; color: var(--text-muted); margin-top: 5px; }

      .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 40px; margin-bottom: 40px; }
      
      .section-title { 
        font-size: 12px; font-weight: 700; color: var(--gold-primary); 
        text-transform: uppercase; letter-spacing: 2px; 
        margin-bottom: 15px; border-bottom: 1px solid var(--border-color);
        padding-bottom: 8px;
        display: flex; align-items: center; gap: 8px;
      }

      .info-group { margin-bottom: 12px; display: flex; justify-content: space-between; font-size: 14px; }
      .info-label { color: var(--text-muted); font-weight: 500; }
      .info-value { font-weight: 600; color: var(--bg-dark); }

      .status-badge {
        padding: 8px 16px; border-radius: 50px; font-size: 12px; font-weight: 700; text-transform: uppercase;
        display: inline-block;
      }
      .status-success { background: #E8F5E9; color: #2E7D32; }
      .status-danger { background: #FFEBEE; color: #C62828; }
      .status-pending { background: #FFF3E0; color: #EF6C00; }

      .findings-card {
        background: #FBFBFB; padding: 30px; border-radius: 12px; border: 1px solid var(--border-color);
        margin-bottom: 40px;
      }

      .notes-box { font-size: 14px; color: var(--text-muted); font-style: italic; margin-top: 15px; padding: 15px; border-left: 3px solid var(--gold-primary); background: #FFF; }

      .photo-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-top: 20px; }
      .photo-item { aspect-ratio: 1; border-radius: 8px; overflow: hidden; border: 1px solid var(--border-color); background: #EEE; position: relative; }
      .photo-item img { width: 100%; height: 100%; object-fit: cover; }
      .photo-item .badge { 
        position: absolute; top: 8px; right: 8px; 
        background: rgba(0,0,0,0.6); color: white; 
        font-size: 10px; padding: 2px 6px; border-radius: 4px;
        backdrop-filter: blur(4px);
      }

      .comparison-section {
        margin-top: 50px;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 30px;
      }

      .comparison-card {
        background: #FAFAFA;
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 20px;
      }

      .footer { margin-top: 60px; padding-top: 30px; border-top: 1px solid var(--border-color); display: flex; justify-content: space-between; font-size: 12px; color: var(--text-muted); }

      @media print {
        body { padding: 0; background: white; }
        .report-container { box-shadow: none; padding: 20px; }
        .no-print { display: none; }
      }
    `;

    const summarySection = `
      <div class="grid">
        <div class="info-block">
          <div class="section-title">${isAr ? 'تفاصيل الطلب' : 'Order Details'}</div>
          <div class="info-group">
            <span class="info-label">${isAr ? 'رقم الطلب' : 'Order Number'}</span>
            <span class="info-value">#${orderNumber}</span>
          </div>
          <div class="info-group">
            <span class="info-label">${isAr ? 'القطعة المطلوبة' : 'Part Name'}</span>
            <span class="info-value">${this.escapeReportHtml(partName)}</span>
          </div>
          <div class="info-group">
            <span class="info-label">${isAr ? 'تاريخ الفحص' : 'Inspection Date'}</span>
            <span class="info-value">${task.completedAt?.toLocaleDateString(isAr ? 'ar-EG' : 'en-GB')}</span>
          </div>
        </div>
        <div class="info-block">
          <div class="section-title">${isAr ? 'أطراف العملية' : 'Stakeholders'}</div>
          <div class="info-group">
            <span class="info-label">${isAr ? 'العميل' : 'Customer'}</span>
            <span class="info-value">${this.escapeReportHtml(customer.name)}</span>
          </div>
          <div class="info-group">
            <span class="info-label">${isAr ? 'المتجر' : 'Store'}</span>
            <span class="info-value">${this.escapeReportHtml(store.name)}</span>
          </div>
          <div class="info-group">
            <span class="info-label">${isAr ? 'الموظف المسؤول' : 'Inspector'}</span>
            <span class="info-value">${this.escapeReportHtml(officer.name)}</span>
          </div>
        </div>
      </div>
    `;

    const photosSection = photos.length > 0 ? `
      <div style="margin-top: 40px;">
        <div class="section-title">${isAr ? 'الأدلة المرئية (الصور الميدانية)' : 'Visual Evidence (Field Photos)'}</div>
        <div class="photo-grid">
          ${photos.map((p: any) => `
            <div class="photo-item">
              <img src="${p.url}" alt="Evidence" onerror="this.src='https://placehold.co/400x400?text=Image+Not+Found'"/>
            </div>
          `).join('')}
        </div>
      </div>
    ` : '';

    return `<!DOCTYPE html>
    <html lang="${isAr ? 'ar' : 'en'}" dir="${isAr ? 'rtl' : 'ltr'}">
    <head>
      <meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <title>Report #${orderNumber}</title>
      <style>${css}</style>
    </head>
    <body>
      <div class="report-container">
        <header>
          <div class="brand-info">
            <div class="brand-logo">
              <img src="${process.env.FRONTEND_URL || ''}/logo.png" alt="E-TASHALEH" onerror="this.src='https://placehold.co/100x100?text=ET'"/>
            </div>
            <div class="brand-name">E-TASHALEH</div>
          </div>
          <div class="report-meta">
            <h1 class="report-title">${isAr ? 'تقرير مطابقة ميدانية' : 'Verification Report'}</h1>
            <div class="report-number">REF: V-${task.id.slice(0, 8).toUpperCase()}</div>
          </div>
          <div class="qr-box" style="width: 85px; height: 85px; border: 1.5px solid var(--gold-primary); padding: 4px; border-radius: 10px; background: white; overflow: hidden; display: flex; align-items: center; justify-content: center;">
             <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent((process.env.FRONTEND_URL || '') + '/admin/verification-tasks/' + task.id)}" 
                  alt="QR" style="width: 100%; height: 100%; object-fit: contain;" />
          </div>
        </header>

        ${summarySection}

        <div class="findings-card">
          <div class="section-title">${isAr ? 'النتيجة النهائية' : 'Final Decision'}</div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 15px;">
            <div class="status-badge ${decisionClass}">${decisionLabel}</div>
            <div style="font-size: 13px; color: var(--text-muted);">
              ${isAr ? 'وقت البدء:' : 'Start:'} ${task.startedAt?.toLocaleTimeString(isAr ? 'ar-EG' : 'en-GB')} | 
              ${isAr ? 'وقت الانتهاء:' : 'End:'} ${task.completedAt?.toLocaleTimeString(isAr ? 'ar-EG' : 'en-GB')}
            </div>
          </div>
          
          ${task.decisionReason ? `
            <div style="margin-top: 20px;">
              <span class="info-label">${isAr ? 'سبب القرار:' : 'Reason:'}</span>
              <div style="font-weight: 600; margin-top: 5px;">${this.escapeReportHtml(task.decisionReason)}</div>
            </div>
          ` : ''}

          ${task.officerNotes ? `
            <div class="notes-box">
              ${this.escapeReportHtml(task.officerNotes)}
            </div>
          ` : ''}
        </div>

        <div class="grid">
          <div class="info-block">
            <div class="section-title">${isAr ? 'معلومات المركبة' : 'Vehicle Specifications'}</div>
            <div class="info-group">
              <span class="info-label">${isAr ? 'الماركة' : 'Make'}</span>
              <span class="info-value">${this.escapeReportHtml(order.vehicleMake)}</span>
            </div>
            <div class="info-group">
              <span class="info-label">${isAr ? 'الموديل' : 'Model'}</span>
              <span class="info-value">${this.escapeReportHtml(order.vehicleModel)}</span>
            </div>
            <div class="info-group">
              <span class="info-label">${isAr ? 'السنة' : 'Year'}</span>
              <span class="info-value">${order.vehicleYear}</span>
            </div>
            <div class="info-group">
              <span class="info-label">${isAr ? 'رقم الهيكل' : 'VIN'}</span>
              <span class="info-value" style="font-family: monospace;">${this.escapeReportHtml(order.vin)}</span>
            </div>
          </div>
          <div class="info-block">
            <div class="section-title">${isAr ? 'الموقع الجغرافي' : 'Geographical Data'}</div>
            <div class="info-group">
              <span class="info-label">${isAr ? 'نقطة البداية' : 'Start Point'}</span>
              <span class="info-value">${task.startLat != null ? Number(task.startLat).toFixed(6) : '—'}, ${task.startLng != null ? Number(task.startLng).toFixed(6) : '—'}</span>
            </div>
            <div class="info-group">
              <span class="info-label">${isAr ? 'نقطة الانتهاء' : 'End Point'}</span>
              <span class="info-value">${task.endLat != null ? Number(task.endLat).toFixed(6) : '—'}, ${task.endLng != null ? Number(task.endLng).toFixed(6) : '—'}</span>
            </div>
            <div style="margin-top: 10px;">
               <a href="https://www.google.com/maps?q=${task.endLat},${task.endLng}" target="_blank" class="no-print" style="color: var(--gold-primary); text-decoration: none; font-size: 12px; font-weight: 600;">
                  📍 ${isAr ? 'عرض الموقع على الخريطة' : 'View on Google Maps'}
               </a>
            </div>
          </div>
        </div>

        <div class="comparison-section">
          <div class="comparison-card">
            <div class="section-title">${isAr ? 'مرجع العميل (الطلب)' : 'Customer Reference'}</div>
            <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 10px;">
              ${this.escapeReportHtml(order.partDescription || (isAr ? 'لا يوجد وصف' : 'No description'))}
            </div>
            <div class="photo-grid" style="grid-template-columns: 1fr 1fr;">
              ${customerImages.map(url => `
                <div class="photo-item">
                  <img src="${url}" alt="Ref" onerror="this.src='https://placehold.co/200?text=Image'"/>
                </div>
              `).join('')}
            </div>
          </div>
          <div class="comparison-card">
            <div class="section-title">${isAr ? 'تجهيز المتجر' : 'Merchant Preparation'}</div>
            <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 10px;">
              ${this.escapeReportHtml(merchantDoc.description || (isAr ? 'لا يوجد وصف' : 'No description'))}
            </div>
            <div class="photo-grid" style="grid-template-columns: 1fr 1fr;">
              ${merchantImages.map(url => `
                <div class="photo-item">
                  <img src="${url}" alt="Merchant" onerror="this.src='https://placehold.co/200?text=Image'"/>
                </div>
              `).join('')}
              ${merchantDoc.videoUrl ? `
                <div class="photo-item" style="display: flex; align-items: center; justify-content: center; background: #000; color: #FFF; font-size: 10px; text-align: center;">
                   VIDEO<br/>PROVIDED
                </div>
              ` : ''}
            </div>
          </div>
        </div>

        ${photosSection}

        <div class="footer">
          <div>© 2026 E-TASHALEH Logistics & Verification System</div>
          <div class="no-print">${isAr ? 'استخدم Ctrl+P لحفظ التقرير كـ PDF' : 'Use Ctrl+P to save as PDF'}</div>
        </div>
      </div>
    </body>
    </html>`;
  }

  async getVerificationReportHtml(taskId: string, userId: string, role: string): Promise<string> {
    const accessProbe = await this.loadTaskForAccess(taskId);
    assertVerificationTaskAccess(accessProbe, userId, role, {
      allowUnassignedOfficer: role === 'VERIFICATION_OFFICER' && !accessProbe.officerId,
    });

    const task = await this.prisma.verificationTask.findUnique({
      where: { id: taskId },
      include: VERIFICATION_TASK_DETAILS_INCLUDE,
    });
    
    if (!task) throw new NotFoundException('Task not found');
    if (!task.completedAt) {
      throw new BadRequestException('Report is available only after the task is completed');
    }

    // Resolve store correctly (same logic as getTaskDetails)
    const latestDoc = task.order.verificationDocuments?.[0];
    const resolvedStore = task.order.store ?? latestDoc?.store ?? null;
    
    const enrichedTask = {
      ...task,
      order: {
        ...task.order,
        store: resolvedStore
      }
    };

    return this.composeVerificationReportHtml(enrichedTask);
  }

  async deactivateTaskLinks(taskId: string) {
    await this.prisma.verificationLink.updateMany({
      where: { taskId, isActive: true },
      data: { isActive: false },
    });
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
        links: { orderBy: { createdAt: 'desc' } },
        fieldPhotos: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: { id: true, url: true, sortOrder: true },
        },
      },
      orderBy: { cycleNumber: 'desc' },
    });
  }

  /** Tasks where the field officer finished with MATCHING and an admin must confirm. */
  async getAdminQueue() {
    return this.prisma.verificationTask.findMany({
      where: { status: 'AWAITING_ADMIN_APPROVAL' },
      include: {
        officer: { select: { id: true, name: true, email: true } },
        order: {
          select: {
            id: true,
            orderNumber: true,
            partName: true,
            vehicleMake: true,
            vehicleModel: true,
            vehicleYear: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async adminReviewFieldVerification(taskId: string, adminId: string, dto: AdminFieldReviewDto) {
    if (!dto.approved && !dto.reason?.trim()) {
      throw new BadRequestException('Rejection reason is required');
    }

    const task = await this.prisma.verificationTask.findUnique({
      where: { id: taskId },
      include: {
        order: {
          include: {
            verificationDocuments: { orderBy: { createdAt: 'desc' }, take: 1 },
          },
        },
      },
    });
    if (!task) throw new NotFoundException('Task not found');
    if (task.status !== 'AWAITING_ADMIN_APPROVAL') {
      throw new BadRequestException('Task is not awaiting admin field approval');
    }

    let newOrderStatus: OrderStatus = task.order.status;
    let correctionDeadline: Date | null = null;
    let newRejectionCount = task.order.rejectionCount;

    if (dto.approved) {
      if (task.order.status === OrderStatus.VERIFICATION_SUCCESS) {
        newOrderStatus = OrderStatus.READY_FOR_SHIPPING;
      }
    } else {
      newRejectionCount += 1;
      if (newRejectionCount >= 2) {
        newOrderStatus = OrderStatus.CANCELLED;
        correctionDeadline = null;
      } else {
        newOrderStatus = OrderStatus.CORRECTION_PERIOD;
        correctionDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.verificationTask.update({
        where: { id: taskId },
        data: { status: dto.approved ? 'ADMIN_APPROVED' : 'ADMIN_REJECTED' },
      });

      const orderData: Prisma.OrderUpdateInput = {
        status: newOrderStatus,
        rejectionCount: newRejectionCount,
      };

      if (dto.approved) {
        if (newOrderStatus === OrderStatus.READY_FOR_SHIPPING) {
          orderData.correctionDeadlineAt = null;
        }
      } else {
        orderData.correctionDeadlineAt = correctionDeadline;
      }

      await tx.order.update({
        where: { id: task.orderId },
        data: orderData,
      });

      await tx.verificationActivityLog.create({
        data: {
          taskId,
          officerId: null,
          action: dto.approved ? 'ADMIN_FIELD_APPROVED' : 'ADMIN_FIELD_REJECTED',
          metadata: { adminId, reason: dto.reason ?? null } as Prisma.InputJsonValue,
        },
      });
    });

    await this.auditLogs
      .logAction({
        orderId: task.orderId,
        action: dto.approved ? 'FIELD_VERIFICATION_ADMIN_APPROVED' : 'FIELD_VERIFICATION_ADMIN_REJECTED',
        entity: 'Order',
        actorType: ActorType.ADMIN,
        actorId: adminId,
        actorName: 'Admin',
        previousState: task.order.status,
        newState: newOrderStatus,
        metadata: {
          taskId,
          reason: dto.reason ?? null,
          timestamp: new Date().toISOString(),
        },
      })
      .catch((err) => this.logger.warn(`audit log field verification review: ${err}`));

    const storeId = task.order.verificationDocuments?.[0]?.storeId;
    if (storeId) {
      void this.notifications
        .notifyMerchantByStoreId(storeId, {
          titleAr: dto.approved ? 'تم اعتماد المطابقة الميدانية' : 'تم رفض اعتماد المطابقة الميدانية',
          titleEn: dto.approved ? 'Field verification approved' : 'Field verification rejected',
          messageAr: dto.approved
            ? `تم اعتماد نتيجة موظف المطابقة للطلب #${task.order.orderNumber}.`
            : `رفض المشرف نتيجة المطابقة الميدانية للطلب #${task.order.orderNumber}. يرجى اتباع تعليمات التصحيح.`,
          messageEn: dto.approved
            ? `Admin approved the field verification for order #${task.order.orderNumber}.`
            : `Admin rejected the field verification for order #${task.order.orderNumber}. Please follow correction instructions.`,
          type: dto.approved ? 'system_alert' : 'system_alert',
          link: `/merchant/orders/${task.order.id}`,
        })
        .catch((e) => this.logger.warn(`merchant notify field review: ${e}`));
    }

    if (task.officerId) {
      void this.notifications
        .notifyUser(task.officerId, 'VERIFICATION_OFFICER', {
          titleAr: dto.approved ? 'تم اعتماد تقريرك' : 'تم رفض التقرير من الإدارة',
          titleEn: dto.approved ? 'Your report was approved' : 'Admin rejected your report',
          messageAr: dto.approved
            ? `تم اعتماد مطابقة الطلب #${task.order.orderNumber} من قبل الإدارة.`
            : `رفض المشرف اعتماد مطابقة الطلب #${task.order.orderNumber}.`,
          messageEn: dto.approved
            ? `Admin approved matching for order #${task.order.orderNumber}.`
            : `Admin did not approve matching for order #${task.order.orderNumber}.`,
          type: 'system',
          link: `/admin/verification-tasks/${taskId}`,
        })
        .catch((e) => this.logger.warn(`officer notify field review: ${e}`));
    }

    return { success: true, orderStatus: newOrderStatus, taskStatus: dto.approved ? 'ADMIN_APPROVED' : 'ADMIN_REJECTED' };
  }

  async getTaskDetails(taskId: string, userId: string, role: string) {
    const accessProbe = await this.loadTaskForAccess(taskId);
    assertVerificationTaskAccess(accessProbe, userId, role, {
      allowUnassignedOfficer: role === 'VERIFICATION_OFFICER' && !accessProbe.officerId,
    });

    const task = await this.prisma.verificationTask.findUnique({
      where: { id: taskId },
      include: VERIFICATION_TASK_DETAILS_INCLUDE,
    });

    if (!task) throw new NotFoundException('Task not found');

    const activeLink = task.links.find((l) => l.isActive) ?? task.links[0] ?? null;
    const sessionDeadline = activeLink
      ? this.computeSessionDeadline(activeLink.expiresAt, activeLink.maxDurationHours, task.startedAt)
      : null;

    const orderTaskHistory = await this.prisma.verificationTask.findMany({
      where: { orderId: task.orderId, id: { not: taskId } },
      orderBy: { cycleNumber: 'desc' },
      select: {
        id: true,
        cycleNumber: true,
        status: true,
        decision: true,
        decisionReason: true,
        officerPhotos: true,
        reportUrl: true,
        completedAt: true,
        createdAt: true,
      },
    });

    const latestDoc = task.order.verificationDocuments?.[0];
    const resolvedStore = task.order.store ?? latestDoc?.store ?? null;

    return {
      ...task,
      order: { ...task.order, store: resolvedStore },
      activeLink,
      sessionDeadline,
      orderTaskHistory,
    };
  }

  async uploadPhotos(taskId: string, officerId: string, photos: string[], lat?: number, lng?: number) {
    if (photos?.some((p) => typeof p === 'string' && p.startsWith('data:'))) {
      throw new BadRequestException(
        'Base64 images are not accepted. Use POST /verification-tasks/:id/field-photos (multipart).',
      );
    }
    void lat;
    void lng;
    void officerId;
    void taskId;
    throw new BadRequestException(
      'Deprecated: upload images with POST /verification-tasks/:id/field-photos as multipart files.',
    );
  }

  async getActivityLog(taskId: string, userId: string, role: string) {
    const accessProbe = await this.loadTaskForAccess(taskId);
    assertVerificationTaskAccess(accessProbe, userId, role, {
      allowUnassignedOfficer: role === 'VERIFICATION_OFFICER' && !accessProbe.officerId,
    });

    return this.prisma.verificationActivityLog.findMany({
      where: { taskId },
      include: {
        officer: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async startVerification(taskId: string, officerId: string, dto: StartVerificationDto) {
    const task = await this.prisma.verificationTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found');
    if (task.officerId !== officerId) throw new ForbiddenException('Not your assigned task');
    if (task.status !== 'ASSIGNED' && task.status !== 'LINK_SENT') {
        throw new BadRequestException('Task is not in a startable state');
    }

    const hasGps =
      dto.lat != null && dto.lng != null && !Number.isNaN(dto.lat) && !Number.isNaN(dto.lng);
    const allowDevBypass =
      process.env.NODE_ENV !== 'production' &&
      (process.env.VERIFICATION_GPS_DEV_BYPASS === 'true' || dto.gpsDevBypass === true);

    if (!hasGps && !allowDevBypass) {
      throw new BadRequestException('GPS location is required to start field verification');
    }

    const startLat = hasGps ? dto.lat : null;
    const startLng = hasGps ? dto.lng : null;
    const deviceInfo = {
      ...(typeof dto.deviceInfo === 'object' && dto.deviceInfo ? dto.deviceInfo : {}),
      ...(allowDevBypass && !hasGps ? { gpsDevBypass: true } : {}),
    };

    await this.prisma.$transaction(async (tx) => {
      await tx.verificationTask.update({
        where: { id: taskId },
        data: {
          status: 'IN_PROGRESS',
          startedAt: new Date(),
          startLat,
          startLng,
          startDeviceInfo: deviceInfo as Prisma.InputJsonValue,
        }
      });

      await tx.verificationActivityLog.create({
        data: {
          taskId,
          officerId,
          action: 'VERIFICATION_STARTED',
          gpsLat: startLat,
          gpsLng: startLng,
          deviceInfo: deviceInfo as Prisma.InputJsonValue,
          metadata: allowDevBypass && !hasGps ? { gpsDevBypass: true } : undefined,
        }
      });
    });

    return { success: true };
  }

  private async dispatchVerificationCompletionNotifications(task: {
    id: string;
    order: { id: string; orderNumber: string; verificationDocuments?: { storeId: string | null }[] };
  }, dto: CompleteVerificationDto) {
    await this.notifications.notifyAdmins({
      titleAr: dto.decision === 'MATCHING' ? 'مطابقة ناجحة تحتاج الاعتماد' : 'تم اكتشاف قطعة غير مطابقة',
      titleEn: dto.decision === 'MATCHING' ? 'Matching Successful - Needs Approval' : 'Non-matching Part Detected',
      messageAr: `قام موظف المطابقة بإنهاء المهمة للطلب #${task.order.orderNumber} بقرار: ${dto.decision === 'MATCHING' ? 'مطابق' : 'غير مطابق'}`,
      messageEn: `Verification Officer completed task for Order #${task.order.orderNumber} with decision: ${dto.decision}`,
      type: 'system',
      link: `/admin/orders/${task.order.id}`,
    });

    const storeId = task.order.verificationDocuments?.[0]?.storeId;
    if (!storeId) return;

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
    } catch (e: any) {
      this.logger.warn(`Failed to notify merchant for task ${task.id}: ${e?.message ?? e}`);
    }
  }

  async completeVerification(taskId: string, officerId: string, dto: CompleteVerificationDto & { lat?: number, lng?: number, deviceInfo?: any }) {
    if (dto.photos?.some((p) => typeof p === 'string' && p.startsWith('data:'))) {
      throw new BadRequestException(
        'Base64 photos are not supported. Use field-photos upload, then complete.',
      );
    }

    const photoUrls = await this.syncOfficerPhotosJsonFromTable(taskId);

    const task = await this.prisma.verificationTask.findUnique({
        where: { id: taskId },
        include: { order: { include: { verificationDocuments: { orderBy: { createdAt: 'desc' }, take: 1 } } } },
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
    if (!photoUrls.length) {
      throw new BadRequestException('At least one verification photo is required (upload via field-photos first)');
    }

    const taskStatus =
      dto.decision === 'MATCHING' ? 'AWAITING_ADMIN_APPROVAL' : 'AWAITING_CORRECTION';

    const reportUrl = this.verificationReportPath(taskId);

    await this.prisma.$transaction(async (tx) => {
        await tx.verificationTask.update({
            where: { id: taskId },
            data: {
                status: taskStatus,
                completedAt: new Date(),
                decision: dto.decision,
                decisionReason: dto.reason,
                officerPhotos: photoUrls,
                officerNotes: dto.notes,
                endLat: dto.lat,
                endLng: dto.lng,
                endDeviceInfo: dto.deviceInfo as Prisma.InputJsonValue | undefined,
                reportUrl,
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

        await tx.verificationActivityLog.create({
          data: { taskId, officerId, action: 'REPORT_GENERATED', metadata: { reportUrl } },
        });
    });

    await this.deactivateTaskLinks(taskId);

    void this.dispatchVerificationCompletionNotifications(
      { id: taskId, order: task.order },
      dto,
    ).catch((err) => this.logger.warn(`verification completion notifications: ${err}`));

    return { success: true, decisionStatus: taskStatus, reportUrl };
  }

  private asImageUrls(value: unknown): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.filter((x): x is string => typeof x === 'string' && x.length > 0);
    }
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return this.asImageUrls(parsed);
      } catch {
        return value.startsWith('http') || value.startsWith('data:') ? [value] : [];
      }
    }
    return [];
  }

  private getCustomerReferenceImages(order: any): string[] {
    const isMulti = order.requestType === 'multiple' || (order.parts?.length ?? 0) > 1;
    if (isMulti) {
      const fromParts = (order.parts ?? []).flatMap((p: any) => this.asImageUrls(p.images));
      const fromOrder = this.asImageUrls(order.partImages);
      return [...new Set([...fromOrder, ...fromParts])];
    }
    const fromOrder = this.asImageUrls(order.partImages);
    if (fromOrder.length > 0) return fromOrder;
    const firstPart = order.parts?.[0];
    return firstPart ? this.asImageUrls(firstPart.images) : [];
  }
}
