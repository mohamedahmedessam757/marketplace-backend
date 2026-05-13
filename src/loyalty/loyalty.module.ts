import { Module, forwardRef } from '@nestjs/common';
import { LoyaltyService } from './loyalty.service';
import { LoyaltyController } from './loyalty.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { LoyaltyGateway } from './loyalty.gateway';
import { NotificationsModule } from '../notifications/notifications.module';
import { MerchantPerformanceModule } from '../merchant-performance/merchant-performance.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { JwtAuthSharedModule } from '../auth/jwt-auth-shared.module';

@Module({
  imports: [
    JwtAuthSharedModule,
    PrismaModule,
    NotificationsModule,
    AuditLogsModule,
    forwardRef(() => MerchantPerformanceModule),
  ],
  controllers: [LoyaltyController],
  providers: [LoyaltyService, LoyaltyGateway],
  exports: [LoyaltyService, LoyaltyGateway],
})
export class LoyaltyModule {}
