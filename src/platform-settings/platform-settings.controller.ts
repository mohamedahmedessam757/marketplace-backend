import { Controller, Get, Put, Body, Param, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PlatformSettingsService } from './platform-settings.service';

@Controller('admin/platform-settings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
export class PlatformSettingsController {
  constructor(private readonly settingsService: PlatformSettingsService) {}

  @Get()
  async getAll() {
    return this.settingsService.getAllSettings();
  }

  @Get(':key')
  async getOne(@Param('key') key: string) {
    return this.settingsService.getSetting(key);
  }

  @Put(':key')
  async update(
    @Request() req,
    @Param('key') key: string,
    @Body() body: { value: any; reason?: string },
  ) {
    const context = this.getContext(req);
    return this.settingsService.updateSetting(
      req.user.id,
      req.user.email,
      key,
      body.value,
      body.reason,
      context,
    );
  }

  @Get('activity/logs')
  @Roles('SUPER_ADMIN')
  async getLogs() {
    return this.settingsService.getAdminActivityLogs();
  }

  @Put('activity/log')
  async logActivity(
    @Request() req,
    @Body() body: { action: string; metadata?: any },
  ) {
    const context = this.getContext(req);
    const userId = req.user?.id || 'ADM-MOCK';
    const email = req.user?.email || 'mock@admin.com';
    return this.settingsService.logAdminActivity(
      userId,
      email,
      body.action,
      body.metadata,
      context,
    );
  }

  private getContext(req: any) {
    const userAgent = req.headers['user-agent'] || 'Unknown';
    let ip = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';

    // Clean IP: Handle proxies and IPv6 mapping
    if (ip.includes(',')) ip = ip.split(',')[0].trim();
    if (ip.startsWith('::ffff:')) ip = ip.substring(7);

    return { ip, ua: userAgent };
  }
}
