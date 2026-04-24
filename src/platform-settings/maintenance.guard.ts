import { Injectable, CanActivate, ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const url = request.url;
    
    // 1. Whitelist Auth, Public System Endpoints & Settings (Necessary to login or see status)
    if (url.includes('/auth/') || url.includes('/platform-settings') || url.includes('/system/')) {
      return true;
    }
    
    // 2. Fetch Maintenance Status
    const statusSetting = await this.prisma.platformSettings.findUnique({
      where: { settingKey: 'system_status' }
    });

    if (!statusSetting) return true;

    const status = statusSetting.settingValue as any;
    const isMaintenance = status?.maintenanceMode === true;

    if (!isMaintenance) return true;

    // 2. Allow Admins to bypass maintenance to allow disabling it
    const user = request.user;
    if (user && (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN' || user.role === 'SUPPORT')) {
      return true;
    }

    // 3. Block all other operations during maintenance
    // We throw 503 Service Unavailable which is the standard for maintenance
    throw new ServiceUnavailableException({
      maintenance: true,
      messageAr: status?.maintenanceMsgAr || 'النظام في وضع الصيانة حالياً لخدمتكم بشكل أفضل.',
      messageEn: status?.maintenanceMsgEn || 'System is currently under maintenance for performance optimization.',
      endTime: status?.endTime || null
    });
  }
}
