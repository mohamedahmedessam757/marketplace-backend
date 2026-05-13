import {
    WebSocketGateway,
    SubscribeMessage,
    MessageBody,
    ConnectedSocket,
    WebSocketServer,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ChatService } from './chat.service';
import { Inject, forwardRef, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { extractSocketJwt, socketIoCorsOptions } from '../common/ws-socket.util';

@WebSocketGateway({
    cors: socketIoCorsOptions(),
    namespace: '/chat'
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit {
    @WebSocketServer()
    server: Server;

    private readonly logger = new Logger(ChatGateway.name);

    constructor(
        @Inject(forwardRef(() => ChatService))
        private readonly chatService: ChatService,
        private readonly jwtService: JwtService,
    ) { }

    afterInit(_server: Server) {
        this.logger.log('Chat WebSocket Gateway Initialized');
    }

    async handleConnection(client: Socket) {
        const token = extractSocketJwt(client);
        if (!token) {
            client.disconnect(true);
            return;
        }
        try {
            const payload = await this.jwtService.verifyAsync<{ sub: string }>(token);
            (client.data as { userId?: string }).userId = payload.sub;
        } catch (e) {
            this.logger.warn(`Chat WS auth failed: ${(e as Error).message}`);
            client.disconnect(true);
        }
    }

    handleDisconnect(client: Socket) {
        this.logger.log(`Client disconnected: ${client.id}`);
    }

    @SubscribeMessage('joinChat')
    async handleJoinChat(
        @ConnectedSocket() client: Socket,
        @MessageBody() payload: { chatId: string; role?: string },
    ) {
        const userId = (client.data as { userId?: string }).userId;
        if (!userId) {
            return { event: 'error', message: 'Unauthorized' };
        }

        if (payload.chatId === 'admin_global') {
            const ok = await this.chatService.userMayJoinAdminGlobal(userId);
            if (!ok) {
                return { event: 'error', message: 'Forbidden' };
            }
            client.join('admin_global');
            this.logger.log(`Administrator ${client.id} joined GLOBAL OVERSIGHT`);
            return { event: 'joined', data: payload.chatId };
        }

        const allowed = await this.chatService.userMayJoinChatRoom(payload.chatId, userId);
        if (!allowed) {
            return { event: 'error', message: 'Forbidden' };
        }
        client.join(payload.chatId);
        this.logger.log(`Client ${client.id} joined chat: ${payload.chatId}`);
        return { event: 'joined', data: payload.chatId };
    }

    @SubscribeMessage('leaveChat')
    handleLeaveChat(
        @ConnectedSocket() client: Socket,
        @MessageBody() payload: { chatId: string },
    ) {
        client.leave(payload.chatId);
        this.logger.log(`Client ${client.id} left chat: ${payload.chatId}`);
        return { event: 'left', data: payload.chatId };
    }

    broadcastChatUpdate(chatId: string, type: 'order' | 'support', metadata?: any) {
        this.server.to('admin_global').emit('chatListUpdate', { chatId, type, ...metadata });

        if (type === 'support' && metadata?.isNew) {
            this.server.to('admin_global').emit('newSupportNotification', {
                chatId,
                name: metadata.name,
                subject: metadata.subject
            });
        }
    }

    @SubscribeMessage('typing')
    handleTyping(
        @ConnectedSocket() client: Socket,
        @MessageBody() payload: { chatId: string; isTyping: boolean; userId: string },
    ) {
        const uid = (client.data as { userId?: string }).userId;
        if (!uid || payload.userId !== uid) {
            return { event: 'error', message: 'Unauthorized' };
        }
        client.to(payload.chatId).emit('userTyping', {
            userId: uid,
            isTyping: payload.isTyping,
        });
        return { event: 'ok' };
    }

    @SubscribeMessage('markRead')
    async handleMarkRead(
        @ConnectedSocket() client: Socket,
        @MessageBody() payload: { chatId: string; userId: string },
    ) {
        const uid = (client.data as { userId?: string }).userId;
        if (!uid || payload.userId !== uid) {
            return { event: 'error', message: 'Unauthorized' };
        }
        try {
            await this.chatService.markMessagesAsRead(payload.chatId, uid);
            return { event: 'ok' };
        } catch (e) {
            this.logger.error('WebSocket markRead failed', e);
            return { event: 'error', message: 'Failed' };
        }
    }

    broadcastNewMessage(chatId: string, message: any) {
        this.server.to(chatId).emit('newMessage', message);
    }
}
