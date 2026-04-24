import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { UAParser } from 'ua-parser-js';
import * as geoip from 'geoip-lite';

@Injectable()
export class PlatformSettingsService {
  private readonly logger = new Logger(PlatformSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /**
   * Fetches all platform settings as a key-value object
   */
  async getAllSettings() {
    const settings = await this.prisma.platformSettings.findMany();
    return settings.reduce((acc, curr) => {
      acc[curr.settingKey] = curr.settingValue;
      return acc;
    }, {});
  }

  /**
   * Fetches a specific setting by key
   */
  async getSetting(key: string) {
    const setting = await this.prisma.platformSettings.findUnique({
      where: { settingKey: key },
    });
    if (!setting) {
      throw new NotFoundException(`Setting with key "${key}" not found`);
    }
    return setting.settingValue;
  }

  /**
   * Updates a specific setting and logs the action
   */
  async updateSetting(
    userId: string,
    email: string,
    key: string,
    value: any,
    reason?: string,
    context?: { ip: string; ua: string },
  ) {
    const oldSetting = await this.prisma.platformSettings.findUnique({
      where: { settingKey: key },
    });

    const updated = await this.prisma.platformSettings.upsert({
      where: { settingKey: key },
      update: {
        settingValue: value,
        updatedAt: new Date(),
      },
      create: {
        settingKey: key,
        settingValue: value,
      },
    });

    // Parse Device Context if available
    let enriched = {};
    if (context) {
      const parser = new UAParser(context.ua);
      const ua = parser.getResult();
      const browser = ua.browser.name
        ? `${ua.browser.name} ${ua.browser.version || ''}`
        : 'Unknown Browser';
      const device = ua.device.model
        ? `${ua.device.vendor || ''} ${ua.device.model}`
        : 'Desktop';

      let location = 'Unknown Location';
      if (context.ip && context.ip !== '127.0.0.1' && context.ip !== '::1') {
        const geo = geoip.lookup(context.ip);
        if (geo) {
          location = [geo.city, geo.region, geo.country]
            .filter(Boolean)
            .join(', ');
        }
      }

      enriched = {
        ip: context.ip,
        ua: context.ua,
        browser,
        device,
        location,
      };
    }

    // AUDIT LOGGING (2026 Best Practice)
    await this.auditLogs.logAction({
      actorId: userId,
      actorType: 'ADMIN',
      action: 'UPDATE',
      entity: 'SYSTEM',
      metadata: {
        settingKey: key,
        oldValue: oldSetting?.settingValue || null,
        newValue: value,
      },
      reason: reason || `Updated system setting: ${key}`,
    });

    // ALSO log to Admin Activity Logs
    await this.logAdminActivity(
      userId,
      email || 'unknown@admin.com',
      `UPDATE_SYSTEM_SETTING_${key.toUpperCase()}`,
      { key, value },
      enriched,
    );

    this.logger.log(`Setting "${key}" updated by user ${userId}`);
    return updated.settingValue;
  }

  async logAdminActivity(
    userId: string,
    email: string,
    action: string,
    metadata: any = {},
    context: { ip?: string; ua?: string; device?: string; browser?: string; location?: string } = {}
  ) {
    // 2026 Resiliency: Ensure logging never crashes the main flow
    try {
      // 1. UUID Validation (standard v4/v5 regex)
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const isValidUuid = userId && uuidRegex.test(userId);
      const isMock = userId && userId.startsWith('ADM-');

      // 2. Prepare Data (Protect against Foreign Key Violated errors)
      // If NOT a valid UUID or is a Mock, we MUST set adminId to null to avoid DB level crashes
      const logData = {
        adminId: (isValidUuid && !isMock) ? userId : null,
        email: email || (isMock ? `${userId}@mock.local` : 'system@platform.com'),
        action: action,
        ipAddress: context.ip || null,
        userAgent: context.ua || null,
        deviceType: context.device || null,
        browser: context.browser || null,
        location: context.location || 'Unknown',
        metadata: {
          ...metadata,
          originalUserId: userId, // Preserve even if not a valid DB UUID
          loggedAt: new Date().toISOString()
        },
      };

      // 3. Attempt creation with fallback
      try {
        return await this.prisma.adminActivityLog.create({ data: logData });
      } catch (prismaError) {
        // If it still fails (e.g. valid UUID but not in Users table), record without adminId
        this.logger.warn(`Logging failed for User ${userId}, retrying without Admin relation...`);
        return await this.prisma.adminActivityLog.create({ 
          data: { ...logData, adminId: null } 
        });
      }
    } catch (criticalError) {
      // Ultimate fallback: don't let activity logging break the platform
      this.logger.error('CRITICAL: Admin activity logging failed completely', criticalError);
      return null;
    }
  }

  /**
   * Fetches the administration activity logs for security audit
   */
  async getAdminActivityLogs() {
    return this.prisma.adminActivityLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        admin: {
          select: {
            email: true,
            name: true,
            role: true
          }
        }
      }
    });
  }
}
