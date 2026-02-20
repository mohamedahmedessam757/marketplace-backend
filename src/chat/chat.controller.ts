
import { Controller, Post, Body, Get, Param, UseGuards, Request, Query } from '@nestjs/common';
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('chats')
@UseGuards(JwtAuthGuard)
export class ChatController {
    constructor(private readonly chatService: ChatService) { }

    @Post('init')
    async initiateChat(
        @Body() body: { orderId: string; vendorId: string },
        @Request() req
    ) {
        // Customer initiates chat
        return this.chatService.createOrGetChat(body.orderId, body.vendorId, req.user.id);
    }

    @Get()
    async getUserChats(@Request() req) {
        // req.user comes from JwtAuthGuard
        return this.chatService.getUserChats(req.user.id, req.user.role);
    }

    @Post(':id/messages')
    async sendMessage(
        @Param('id') chatId: string,
        @Body() body: { text: string },
        @Request() req
    ) {
        return this.chatService.sendMessage(chatId, req.user.id, body.text);
    }

    @Post(':id/translation')
    async toggleTranslation(
        @Param('id') chatId: string,
        @Body() body: { enabled: boolean }
    ) {
        return this.chatService.toggleTranslation(chatId, body.enabled);
    }
}
