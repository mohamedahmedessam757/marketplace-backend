import { Controller, Get, Post, Body, UseGuards, Request } from '@nestjs/common';
import { LoyaltyService } from './loyalty.service';
import { AuthGuard } from '@nestjs/passport';

@Controller('loyalty')
@UseGuards(AuthGuard('jwt'))
export class LoyaltyController {
  constructor(private readonly loyaltyService: LoyaltyService) {}

  @Get('me')
  async getMyLoyalty(@Request() req) {
    return this.loyaltyService.getLoyaltyData(req.user.id);
  }

  @Get('referrals')
  async getMyReferrals(@Request() req) {
    return this.loyaltyService.getReferralHistory(req.user.id);
  }

  @Get('public-stats')
  async getPublicStats() {
    return this.loyaltyService.getPublicStats();
  }

  @Post('redeem')
  async redeemPoints(
    @Request() req,
    @Body() body: { amount: number; description: string },
  ) {
    return this.loyaltyService.redeemPoints(
      req.user.id,
      body.amount,
      body.description || 'Points redeemed',
    );
  }
}
