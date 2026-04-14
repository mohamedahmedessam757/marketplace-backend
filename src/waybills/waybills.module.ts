import { Module } from '@nestjs/common';
import { WaybillsController } from './waybills.controller';
import { WaybillsService } from './waybills.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ShipmentsModule } from '../shipments/shipments.module';

@Module({
  imports: [
    PrismaModule, 
    NotificationsModule,
    AuditLogsModule,
    ShipmentsModule
  ],
  controllers: [WaybillsController],
  providers: [WaybillsService],
  exports: [WaybillsService],
})
export class WaybillsModule {}
