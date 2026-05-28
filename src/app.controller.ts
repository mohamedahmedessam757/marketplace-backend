import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { PlatformSettingsService } from './platform-settings/platform-settings.service';

@Controller()
export class AppController {
    constructor(private prisma: PrismaService) {}

    @Get()
    getRoot() {
        return { status: 'ok', message: 'E-Tashleh API is running' };
    }

    @Get('health')
    async healthCheck() {
        const dbOk = await this.prisma.isHealthy();
        return {
            status: dbOk ? 'healthy' : 'degraded',
            database: dbOk ? 'connected' : 'unreachable',
            timestamp: new Date().toISOString(),
        };
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

    @Get('system/feature-flags')
    async getFeatureFlags() {
        const settings = await this.prisma.platformSettings.findMany({
            where: {
                settingKey: {
                    in: ['CHAT_ATTACHMENTS_ENABLED', 'ALLOW_CUSTOMER_ACCOUNT_DELETION']
                }
            }
        });
        
        const getVal = (key: string, defaultVal: boolean) => {
            const s = settings.find(x => x.settingKey === key);
            // Handle both primitive boolean and JSON string format
            if (s) {
                if (typeof s.settingValue === 'boolean') return s.settingValue;
                if (typeof s.settingValue === 'string') return s.settingValue.toLowerCase() === 'true';
                if (typeof s.settingValue === 'object' && s.settingValue !== null) {
                    // Just in case it's stored as {"value": false}
                    const obj = s.settingValue as any;
                    if ('value' in obj) return obj.value;
                }
                return Boolean(s.settingValue);
            }
            return defaultVal;
        };

        return {
            CHAT_ATTACHMENTS_ENABLED: getVal('CHAT_ATTACHMENTS_ENABLED', true),
            ALLOW_CUSTOMER_ACCOUNT_DELETION: getVal('ALLOW_CUSTOMER_ACCOUNT_DELETION', true)
        };
    }

}
