import { Injectable, CanActivate, ExecutionContext, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MaintenanceGuard implements CanActivate {
  private readonly logger = new Logger(MaintenanceGuard.name);

  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const url = request.url;

    // 1. Whitelist Auth, Public System Endpoints & Settings (Necessary to login or see status)
    if (
      url.includes('/auth/') ||
      url.includes('/platform-settings') ||
      url.includes('/system/') ||
      url.includes('/public/documents/')
    ) {
      return true;
    }

    try {
      if (!(await this.prisma.ensureConnected())) {
        this.logger.warn('Database unreachable — skipping maintenance check (fail-open).');
        return true;
      }

      // 2. Fetch Maintenance Status
      const statusSetting = await this.prisma.platformSettings.findUnique({
        where: { settingKey: 'system_status' },
      });

      if (!statusSetting) return true;

      const status = statusSetting.settingValue as any;
      const isMaintenance = status?.maintenanceMode === true;

      if (!isMaintenance) return true;

      const user = request.user;
      if (user?.id) {
        const dbUser = await this.prisma.user.findUnique({
          where: { id: user.id },
          select: { role: true },
        });
        const r = (dbUser?.role || user.role || '').toString().toUpperCase();
        if (r === 'SUPER_ADMIN' || r === 'ADMIN' || r === 'SUPPORT') {
          return true;
        }
      }

      // 3. Block all other operations during maintenance
      throw new ServiceUnavailableException({
        maintenance: true,
        messageAr: status?.maintenanceMsgAr || 'النظام في وضع الصيانة حالياً لخدمتكم بشكل أفضل.',
        messageEn: status?.maintenanceMsgEn || 'System is currently under maintenance for performance optimization.',
        endTime: status?.endTime || null,
      });
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      // Transient DB outage — do not flood 500 errors; allow traffic until DB recovers
      this.logger.warn(
        `Maintenance guard DB error (fail-open): ${error instanceof Error ? error.message : error}`,
      );
      return true;
    }
  }
}
