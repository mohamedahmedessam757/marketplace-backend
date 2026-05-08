import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY, PermissionRequirement } from '../decorators/permissions.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole } from '@prisma/client';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<PermissionRequirement>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If no permission metadata is set, allow (or you can choose to deny by default)
    if (!requirement) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    
    if (!user || !user.id) {
      return false;
    }

    // 2026 Security: Fetch fresh role from DB to prevent stale JWT role issues
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { role: true }
    });

    const currentRole = (dbUser?.role || user.role || '').toString().toUpperCase();
    
    // High-level Admins are the ultimate authority
    if (currentRole === 'SUPER_ADMIN' || currentRole === 'ADMIN') {
      return true;
    }

    // Fetch the specific permissions for this admin user
    const adminPerm = await this.prisma.adminPermission.findUnique({
      where: { userId: user.id },
    });

    if (!adminPerm) {
      throw new ForbiddenException('Admin account has no permissions record');
    }

    if (!adminPerm.isActive) {
      throw new ForbiddenException('Admin account is inactive');
    }

    const permissions = adminPerm.permissions as any;
    const { page, action } = requirement;

    // Ensure permissions object and the specific page key exist
    const pagePerms = permissions && typeof permissions === 'object' ? permissions[page] : null;
    
    // Check granular access with safety fallback
    const hasAccess = pagePerms && pagePerms[action] === true;

    if (!hasAccess) {
      throw new ForbiddenException(`Access Denied: Missing ${action} permission for ${page}`);
    }

    return true;
  }
}
