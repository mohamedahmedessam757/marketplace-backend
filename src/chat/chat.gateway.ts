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
     * Join a specific chat room.
     * Both Merchant and Customer will join the room corresponding to the chat ID.
     */
    @SubscribeMessage('joinChat')
    handleJoinChat(
        @ConnectedSocket() client: Socket,
        @MessageBody() payload: { chatId: string },
    ) {
        client.join(payload.chatId);
        console.log(`Client ${client.id} joined chat: ${payload.chatId}`);
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
     * Central message dispatcher (Opt-in, if you prefer sockets over HTTP for sending)
     * Currently using HTTP in controller and updating real-time via Supabase, 
     * but we can broadcast here for 0ms latency.
     */
    broadcastNewMessage(chatId: string, message: any) {
        this.server.to(chatId).emit('newMessage', message);
    }
}
