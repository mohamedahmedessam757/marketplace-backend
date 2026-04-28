import { Controller, Get, Put, Body, Req } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { PlatformSettingsService } from './platform-settings/platform-settings.service';

@Controller()
export class AppController {
    constructor(
        private prisma: PrismaService,
        private settingsService: PlatformSettingsService
    ) {}

    @Get()
    getRoot() {
        return { status: 'ok', message: 'E-Tashleh API is running' };
    }

    @Get('health')
    healthCheck() {
        return { status: 'healthy', timestamp: new Date().toISOString() };
    }

    @Get('system/status')
    async getSystemStatus() {
        const statusSetting = await this.prisma.platformSettings.findUnique({
            where: { settingKey: 'system_status' }
        });
        
        if (!statusSetting || !statusSetting.settingValue) {
            return { maintenanceMode: false };
        }
        
        // Safely parse the stored value — handles both object and string formats
        const value = statusSetting.settingValue as any;
        
        return {
            maintenanceMode: value?.maintenanceMode === true,
            endTime: value?.endTime || null,
            maintenanceMsgAr: value?.maintenanceMsgAr || 'النظام في وضع الصيانة',
            maintenanceMsgEn: value?.maintenanceMsgEn || 'System Under Maintenance',
        };
    }

    @Get('system/config')
    async getSystemConfig() {
        const configSetting = await this.prisma.platformSettings.findUnique({
            where: { settingKey: 'system_config' }
        });
        
        return configSetting?.settingValue || {};
    }

    @Put('system/mock-admin-log')
    async mockAdminLog(@Body() body: { email: string, action: string, metadata?: any }, @Req() req: any) {
        // Extract real device info if not provided in metadata
        const userAgent = req.headers['user-agent'] || 'Unknown';
        let ip = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';

        // Clean IP
        if (ip.includes(',')) ip = ip.split(',')[0].trim();
        if (ip.startsWith('::ffff:')) ip = ip.substring(7);
        
        return this.settingsService.logAdminActivity(
            null,
            body.email,
            body.action,
            body.metadata || {},
            { 
                ip: body.metadata?.ipAddress || ip, 
                ua: userAgent, 
                device: body.metadata?.deviceType || this.parseDevice(userAgent), 
                browser: body.metadata?.browser || this.parseBrowser(userAgent), 
                location: body.metadata?.location || 'Unknown' 
            }
        );
    }

    private parseBrowser(ua: string) {
        if (ua.includes('Chrome')) return 'Chrome';
        if (ua.includes('Firefox')) return 'Firefox';
        if (ua.includes('Safari')) return 'Safari';
        if (ua.includes('Edge')) return 'Edge';
        return 'Browser';
    }

    private parseDevice(ua: string) {
        if (ua.includes('Mobile')) return 'Mobile';
        if (ua.includes('Tablet')) return 'Tablet';
        return 'Desktop';
    }
}
