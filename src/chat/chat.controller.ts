
import { Controller, Post, Body, Get, Param, UseGuards, Request, Query, ForbiddenException } from '@nestjs/common';
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('chats')
@UseGuards(JwtAuthGuard)
export class ChatController {
    constructor(private readonly chatService: ChatService) { }

    // -------------------------------------------------------
    // LIST ROUTE
    // -------------------------------------------------------

    @Get()
    async getUserChats(
        @Request() req,
        @Query('type') type?: string
    ) {
        return this.chatService.getUserChats(req.user.id, req.user.role, type);
    }

    // -------------------------------------------------------
    // FIXED-PATH ROUTES — Must come BEFORE any dynamic :id routes
    // to prevent NestJS from matching them as route parameters.
    // -------------------------------------------------------

    @Post('init')
    async initiateChat(
        @Body() body: { orderId: string; vendorId: string },
        @Request() req
    ) {
        if (req.user.role !== 'CUSTOMER') {
            throw new ForbiddenException('Only customers can initiate order chats.');
        }
        return this.chatService.createOrGetChat(body.orderId, body.vendorId, req.user.id);
    }

    @Post('support')
    async initSupportChat(
        @Body() body: { subject: string; message: string; orderId?: string; mediaUrl?: string; mediaType?: string; mediaName?: string; priority?: string },
        @Request() req
    ) {
        return this.chatService.createSupportChat(req.user.id, body.subject, body.message, body.orderId, body.mediaUrl, body.mediaType, body.mediaName, body.priority);
    }

    @Post('admin-init-support')
    async adminInitSupportChat(
        @Body() body: { targetUserId: string; targetRole: 'CUSTOMER' | 'VENDOR'; reason: string; orderId?: string },
        @Request() req
    ) {
        if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
            throw new ForbiddenException('Forbidden: Admin only');
        }
        return this.chatService.initAdminSupportChat(
            req.user.id,
            req.user.name || 'Administrator',
            body.targetUserId,
            body.targetRole,
            body.reason,
            body.orderId
        );
    }

    @Get('admin/user-risk/:userId')
    async getUserRiskProfile(
        @Param('userId') userId: string,
        @Request() req
    ) {
        if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
            throw new ForbiddenException('Forbidden: Admin only');
        }
        return this.chatService.getUserRiskProfile(userId);
    }

    // -------------------------------------------------------
    // DYNAMIC :id ROUTES — Must come AFTER all fixed-path routes
    // -------------------------------------------------------

    @Get(':id')
    async getChatById(@Param('id') id: string) {
        return this.chatService.getChatById(id);
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
            throw new ForbiddenException('Forbidden: Admin only');
        }
        return this.chatService.adminAction(req.user.id, chatId, body.action, body.payload);
    }
}
