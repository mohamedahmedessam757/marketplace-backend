import { Injectable, ConflictException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { NotificationsService } from '../notifications/notifications.service';
import * as bcrypt from 'bcrypt';
import { CreateAdminDto, UpdatePermissionsDto, ChangeAdminPasswordDto } from './dto/admin-permissions.dto';
import { ActorType, UserRole } from '@prisma/client';

@Injectable()
export class AdminPermissionsService {
  constructor(
    private prisma: PrismaService,
    private auditLogs: AuditLogsService,
    private notifications: NotificationsService,
  ) {}

  async createAdmin(dto: CreateAdminDto, createdById: string) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 12);

    return this.prisma.$transaction(async (tx) => {
      // 1. Create User
      const user = await tx.user.create({
        data: {
          email: dto.email,
          passwordHash: hashedPassword,
          name: dto.name,
          role: dto.role,
          status: 'ACTIVE',
        },
      });

      // 2. Create Permissions
      const permissions = await tx.adminPermission.create({
        data: {
          userId: user.id,
          permissions: dto.permissions as any,
          supportTicketCategories: dto.supportTicketCategories || [],
          blurredSections: dto.blurredSections || [],
          createdById,
          updatedById: createdById,
        },
      });

      // 3. Audit Log
      await this.auditLogs.logAction({
        action: 'CREATE_ADMIN_ACCOUNT',
        entity: 'USER',
        actorType: ActorType.ADMIN,
        actorId: createdById,
        newState: JSON.stringify({ email: user.email, role: user.role }),
        reason: 'Super Admin created new administrative account',
        metadata: { targetUserId: user.id, role: user.role }
      }, tx);

      return { user, permissions };
    });
  }

  async updatePermissions(targetUserId: string, dto: UpdatePermissionsDto, updatedById: string) {
    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      include: { adminPermission: true }
    });

    if (!targetUser) throw new NotFoundException('Admin user not found');
    
    // Prevent modifying other Super Admins unless the actor is the root or specific policy
    // For now, let's assume any Super Admin can manage others, but usually, we'd restrict this.
    
    return this.prisma.$transaction(async (tx) => {
      // Update User Role if provided
      if (dto.role) {
        await tx.user.update({
          where: { id: targetUserId },
          data: { role: dto.role }
        });
      }

      // Update Permissions
      const updatedPermissions = await tx.adminPermission.upsert({
        where: { userId: targetUserId },
        create: {
          userId: targetUserId,
          permissions: (dto.permissions as any) || {},
          supportTicketCategories: dto.supportTicketCategories || [],
          blurredSections: dto.blurredSections || [],
          createdById: updatedById,
          updatedById: updatedById,
        },
        update: {
          permissions: dto.permissions ? (dto.permissions as any) : undefined,
          supportTicketCategories: dto.supportTicketCategories,
          blurredSections: dto.blurredSections,
          updatedById,
          updatedAt: new Date(),
        },
      });

      // Audit Log
      await this.auditLogs.logAction({
        action: 'UPDATE_ADMIN_PERMISSIONS',
        entity: 'ADMIN_PERMISSION',
        actorType: ActorType.ADMIN,
        actorId: updatedById,
        newState: JSON.stringify(dto),
        reason: 'Administrative permissions update',
        metadata: { targetUserId }
      }, tx);

      return updatedPermissions;
    });
  }

  async findAllAdmins() {
    return this.prisma.user.findMany({
      where: {
        role: { in: [UserRole.ADMIN, UserRole.SUPPORT, UserRole.SUPER_ADMIN, UserRole.VERIFICATION_OFFICER] }
      },
      include: {
        adminPermission: true
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async getAdminById(userId: string) {
    const admin = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { adminPermission: true }
    });
    if (!admin) throw new NotFoundException('Admin not found');
    return admin;
  }

  async deleteAdmin(targetUserId: string, actorId: string) {
    if (targetUserId === actorId) throw new ForbiddenException('You cannot delete your own account');

    const targetUser = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!targetUser) throw new NotFoundException('Admin not found');

    return this.prisma.$transaction(async (tx) => {
      // Soft delete: Change status to SUSPENDED and remove permissions record
      // Or Hard delete: Plan suggested Hard delete but mentioned soft delete in question. 
      // I'll implement soft delete for safety as per 2026 standards.
      
      await tx.user.update({
        where: { id: targetUserId },
        data: { status: 'SUSPENDED', suspendReason: 'Account deleted by Super Admin' }
      });

      await tx.adminPermission.upsert({
        where: { userId: targetUserId },
        update: { isActive: false },
        create: {
          userId: targetUserId,
          permissions: {},
          isActive: false,
          createdById: actorId,
          updatedById: actorId,
        },
      });

      await this.auditLogs.logAction({
        action: 'DELETE_ADMIN_ACCOUNT',
        entity: 'USER',
        actorType: ActorType.ADMIN,
        actorId,
        reason: 'Administrative account deletion (Soft Delete)',
        metadata: { targetUserId, email: targetUser.email }
      }, tx);

      return { success: true };
    });
  }

  async updateAdminPassword(targetUserId: string, dto: ChangeAdminPasswordDto, actorId: string) {
    const hashedPassword = await bcrypt.hash(dto.newPassword, 12);
    
    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { passwordHash: hashedPassword }
    });

    await this.auditLogs.logAction({
      action: 'ADMIN_PASSWORD_CHANGE',
      entity: 'USER',
      actorType: ActorType.ADMIN,
      actorId,
      reason: 'Administrative password reset',
      metadata: { targetUserId }
    });

    return { success: true };
  }

  async getMyPermissions(userId: string) {
    return this.prisma.adminPermission.findUnique({
      where: { userId }
    });
  }
}
