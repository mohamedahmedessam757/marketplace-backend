import { Module, forwardRef } from '@nestjs/common';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { MerchantPerformanceModule } from '../merchant-performance/merchant-performance.module';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    AuditLogsModule,
    forwardRef(() => MerchantPerformanceModule),
  ],
  controllers: [ReviewsController],
  providers: [ReviewsService]
})
export class ReviewsModule {}
