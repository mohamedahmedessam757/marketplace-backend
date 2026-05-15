import { Module } from '@nestjs/common';
import { VerificationTasksService } from './verification-tasks.service';
import { VerificationTasksController } from './verification-tasks.controller';
import { VerificationTasksPublicController } from './verification-tasks-public.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [NotificationsModule, AuditLogsModule, UploadsModule],
  providers: [VerificationTasksService],
  controllers: [VerificationTasksController, VerificationTasksPublicController],
  exports: [VerificationTasksService],
})
export class VerificationTasksModule {}
