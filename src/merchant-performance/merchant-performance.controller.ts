import { Controller, Get, UseGuards, Request, NotFoundException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { MerchantPerformanceService } from './merchant-performance.service';

@Controller('merchant-performance')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.VENDOR)
export class MerchantPerformanceController {
  constructor(private readonly merchantPerformance: MerchantPerformanceService) {}

  /** Aggregated dashboard: tiers, benefits table, progress, subscription, violations summary */
  @Get('me')
  async getMe(@Request() req: { user: { id: string } }) {
    const data = await this.merchantPerformance.getDashboardForOwner(req.user.id);
    if (!data) throw new NotFoundException('Store not found');
    return data;
  }
}
