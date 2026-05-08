import { Module } from '@nestjs/common';
import { ReturnsController } from './returns.controller';
import { ReturnsService } from './returns.service';
import { UploadsModule } from '../uploads/uploads.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { UsersModule } from '../users/users.module';

import { ReturnsCronService } from './returns.cron';
import { PaymentsModule } from '../payments/payments.module';

@Module({
    imports: [UploadsModule, NotificationsModule, AuditLogsModule, UsersModule, PaymentsModule],
    controllers: [ReturnsController],
    providers: [ReturnsService, ReturnsCronService],
})
export class ReturnsModule { }
