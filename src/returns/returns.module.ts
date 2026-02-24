import { Module } from '@nestjs/common';
import { ReturnsController } from './returns.controller';
import { ReturnsService } from './returns.service';
import { UploadsModule } from '../uploads/uploads.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
    imports: [UploadsModule, NotificationsModule],
    controllers: [ReturnsController],
    providers: [ReturnsService],
})
export class ReturnsModule { }
