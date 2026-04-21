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
import { Inject, forwardRef } from '@nestjs/common';

@WebSocketGateway({
    cors: {
        origin: '*', // Allow all origins for now. Configure appropriately for production.
    },
    namespace: '/chat'
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit {
    @WebSocketServer()
    server: Server;

    constructor(
        @Inject(forwardRef(() => ChatService))
        private readonly chatService: ChatService
    ) { }

    afterInit(server: Server) {
        console.log('Chat WebSocket Gateway Initialized');
    }

    handleConnection(client: Socket) {
        // Authenticate client here if needed via headers or handshake query
        console.log(`Client connected: ${client.id}`);
    }

    handleDisconnect(client: Socket) {
        console.log(`Client disconnected: ${client.id}`);
    }

    /**
     * Join a specific chat room or the global admin oversight room.
     */
    @SubscribeMessage('joinChat')
    handleJoinChat(
        @ConnectedSocket() client: Socket,
        @MessageBody() payload: { chatId: string; role?: string },
    ) {
        // If it's a specific chat, join that room
        if (payload.chatId !== 'admin_global') {
            client.join(payload.chatId);
            console.log(`Client ${client.id} joined chat: ${payload.chatId}`);
        } else if (payload.role === 'admin' || payload.role === 'SUPER_ADMIN') {
            // Join the global room for list updates
            client.join('admin_global');
            console.log(`Administrator ${client.id} joined GLOBAL OVERSIGHT`);
        }
        
        return { event: 'joined', data: payload.chatId };
    }

    /**
     * Leave a specific chat room.
     */
    @SubscribeMessage('leaveChat')
    handleLeaveChat(
        @ConnectedSocket() client: Socket,
        @MessageBody() payload: { chatId: string },
    ) {
        client.leave(payload.chatId);
        console.log(`Client ${client.id} left chat: ${payload.chatId}`);
        return { event: 'left', data: payload.chatId };
    }

    /**
     * Broadcast an update to the admin list for any chat activity.
     */
    broadcastChatUpdate(chatId: string, type: 'order' | 'support', metadata?: any) {
        this.server.to('admin_global').emit('chatListUpdate', { chatId, type, ...metadata });
        
        // Special event for new support tickets to trigger UI notifications
        if (type === 'support' && metadata?.isNew) {
            this.server.to('admin_global').emit('newSupportNotification', { 
                chatId, 
                name: metadata.name, 
                subject: metadata.subject 
            });
        }
    }

    /**
     * Handles typing indicators to be broadcasted to the room.
     */
    @SubscribeMessage('typing')
    handleTyping(
        @ConnectedSocket() client: Socket,
        @MessageBody() payload: { chatId: string; isTyping: boolean; userId: string },
    ) {
        // Broadcast to everyone in the room EXCEPT the sender
        client.to(payload.chatId).emit('userTyping', {
            userId: payload.userId,
            isTyping: payload.isTyping,
        });
    }

    /**
     * Handle read receipts via WebSocket (alternative to HTTP POST /chats/:id/read).
     * Clients emit 'markRead' with { chatId, userId } to mark messages as read.
     */
    @SubscribeMessage('markRead')
    async handleMarkRead(
        @ConnectedSocket() client: Socket,
        @MessageBody() payload: { chatId: string; userId: string },
    ) {
        try {
            await this.chatService.markMessagesAsRead(payload.chatId, payload.userId);
        } catch (e) {
            console.error('WebSocket markRead failed:', e);
        }
    }

    /**
     * Central message dispatcher (Opt-in, if you prefer sockets over HTTP for sending)
     * Currently using HTTP in controller and updating real-time via Supabase, 
     * but we can broadcast here for 0ms latency.
     */
    broadcastNewMessage(chatId: string, message: any) {
        this.server.to(chatId).emit('newMessage', message);
    }
}
