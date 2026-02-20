
import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from './chat.gateway';

@Module({
    controllers: [ChatController],
    providers: [ChatService, PrismaService, ChatGateway],
    exports: [ChatService, ChatGateway],
})
export class ChatModule { }
