import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsGateway } from './notifications.gateway';
import { JwtAuthSharedModule } from '../auth/jwt-auth-shared.module';

@Module({
    imports: [PrismaModule, JwtAuthSharedModule],
    controllers: [NotificationsController],
    providers: [NotificationsService, NotificationsGateway],
    exports: [NotificationsService],
})
export class NotificationsModule { }
