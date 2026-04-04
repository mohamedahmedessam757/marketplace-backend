
import { Controller, Post, Body, Get, Param, UseGuards, Request, Query, ForbiddenException } from '@nestjs/common';
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
        if (req.user.role !== 'customer') {
            throw new ForbiddenException('Only customers can initiate order chats.');
        }

        // Customer initiates chat
        return this.chatService.createOrGetChat(body.orderId, body.vendorId, req.user.id);
    }

    @Get()
    async getUserChats(
        @Request() req,
        @Query('type') type?: string
    ) {
        // req.user comes from JwtAuthGuard
        return this.chatService.getUserChats(req.user.id, req.user.role, type);
    }

    @Get(':id')
    async getChatById(@Param('id') id: string) {
        return this.chatService.getChatById(id);
    }

    @Post('support')
    async initSupportChat(
        @Body() body: { subject: string; message: string; orderId?: string; mediaUrl?: string; mediaType?: string; mediaName?: string; priority?: string },
        @Request() req
    ) {
        // Customer creates a Support ticket (type: support). orderId is optional for generic inquiries.
        return this.chatService.createSupportChat(req.user.id, body.subject, body.message, body.orderId, body.mediaUrl, body.mediaType, body.mediaName, body.priority);
    }

    @Post(':id/messages')
    async sendMessage(
        @Param('id') chatId: string,
        @Body() body: { text?: string; mediaUrl?: string; mediaType?: string; mediaName?: string; priority?: string; subject?: string },
        @Request() req
    ) {
        return this.chatService.sendMessage(
            chatId,
            req.user.id,
            body.text || '',
            req.user.role,
            body.mediaUrl,
            body.mediaType,
            body.mediaName,
            body.priority,
            body.subject
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

    @Post(':id/read')
    async markAsRead(
        @Param('id') chatId: string,
        @Request() req
    ) {
        return this.chatService.markMessagesAsRead(chatId, req.user.id);
    }

    @Post(':id/admin-action')
    async adminAction(
        @Param('id') chatId: string,
        @Body() body: { action: 'close' | 'block' | 'join' | 'deleteChat' | 'deleteMessage' | 'evidence', payload?: any },
        @Request() req
    ) {
        if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
            throw new Error('Forbidden: Admin only');
        }
        return this.chatService.adminAction(chatId, body.action, body.payload);
    }
}
