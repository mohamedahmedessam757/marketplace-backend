import { Controller, Get, UseGuards, Request } from '@nestjs/common';
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
}
