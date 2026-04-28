import { Module } from '@nestjs/common';
import { ReturnsController } from './returns.controller';
import { ReturnsService } from './returns.service';
import { UploadsModule } from '../uploads/uploads.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

import { ReturnsCronService } from './returns.cron';

@Module({
    imports: [UploadsModule, NotificationsModule, AuditLogsModule],
    controllers: [ReturnsController],
    providers: [ReturnsService, ReturnsCronService],
})
export class ReturnsModule { }
