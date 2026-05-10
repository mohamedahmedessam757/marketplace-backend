import { Module, forwardRef } from '@nestjs/common';
import { MerchantPerformanceService } from './merchant-performance.service';
import { MerchantPerformanceController } from './merchant-performance.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    forwardRef(() => LoyaltyModule),
  ],
  controllers: [MerchantPerformanceController],
  providers: [MerchantPerformanceService],
  exports: [MerchantPerformanceService],
})
export class MerchantPerformanceModule {}
