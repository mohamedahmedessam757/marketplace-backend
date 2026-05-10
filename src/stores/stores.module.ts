import { Module, forwardRef } from '@nestjs/common';
import { StoresService } from './stores.service';
import { StoresController } from './stores.controller';
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
    controllers: [StoresController],
    providers: [StoresService],
    exports: [StoresService],
})
export class StoresModule { }
