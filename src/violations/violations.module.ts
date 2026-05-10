import { Module, forwardRef } from '@nestjs/common';
import { ViolationsService } from './violations.service';
import { ViolationsController } from './violations.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MerchantPerformanceModule } from '../merchant-performance/merchant-performance.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    forwardRef(() => MerchantPerformanceModule),
    forwardRef(() => LoyaltyModule),
  ],
  controllers: [ViolationsController],
  providers: [ViolationsService],
  exports: [ViolationsService], // Export for scheduler/decay jobs
})
export class ViolationsModule {}
