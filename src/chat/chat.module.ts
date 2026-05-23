import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { PublicChatController } from './public-chat.controller';
import { ChatService } from './chat.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from './chat.gateway';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { JwtAuthSharedModule } from '../auth/jwt-auth-shared.module';
import { ViolationsModule } from '../violations/violations.module';

@Module({
    imports: [JwtAuthSharedModule, NotificationsModule, AuditLogsModule, ViolationsModule],
    controllers: [ChatController, PublicChatController],
    providers: [ChatService, PrismaService, ChatGateway],
    exports: [ChatService, ChatGateway],
})
export class ChatModule { }
