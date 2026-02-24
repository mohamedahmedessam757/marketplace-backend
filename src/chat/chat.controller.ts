
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

    @Get(':id')
    async getChatById(@Param('id') id: string) {
        return this.chatService.getChatById(id);
    }

    @Post('support')
    async initSupportChat(
        @Body() body: { subject: string; message: string; orderId?: string },
        @Request() req
    ) {
        // Customer creates a Support ticket (type: support). orderId is optional for generic inquiries.
        return this.chatService.createSupportChat(req.user.id, body.subject, body.message, body.orderId);
    }

    @Post(':id/messages')
    async sendMessage(
        @Param('id') chatId: string,
        @Body() body: { text?: string; mediaUrl?: string; mediaType?: string; mediaName?: string },
        @Request() req
    ) {
        return this.chatService.sendMessage(
            chatId,
            req.user.id,
            body.text || '',
            req.user.role,
            body.mediaUrl,
            body.mediaType,
            body.mediaName
        );
    }

    @Post(':id/translation')
    async toggleTranslation(
        @Param('id') chatId: string,
        @Body() body: { enabled: boolean },
        @Request() req
    ) {
        // Use req.user.role to set the translation timestamp selectively for the invoker
        return this.chatService.toggleTranslation(chatId, req.user.role, body.enabled);
    }
}
