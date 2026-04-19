import { Module } from '@nestjs/common';
import { ViolationsService } from './violations.service';
import { ViolationsController } from './violations.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [ViolationsController],
  providers: [ViolationsService],
  exports: [ViolationsService], // Export for scheduler/decay jobs
})
export class ViolationsModule {}
