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
import { Inject, forwardRef, Logger } from '@nestjs/common';
import { LoyaltyService } from './loyalty.service';

@WebSocketGateway({
    cors: {
        origin: '*',
    },
    namespace: '/loyalty'
})
export class LoyaltyGateway implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit {
    @WebSocketServer()
    server: Server;

    private readonly logger = new Logger(LoyaltyGateway.name);

    constructor(
        @Inject(forwardRef(() => LoyaltyService))
        private readonly loyaltyService: LoyaltyService
    ) { }

    afterInit(server: Server) {
        this.logger.log('Loyalty WebSocket Gateway Initialized');
    }

    handleConnection(client: Socket) {
        this.logger.log(`Client connected to Loyalty: ${client.id}`);
    }

    handleDisconnect(client: Socket) {
        this.logger.log(`Client disconnected from Loyalty: ${client.id}`);
    }

    /**
     * Join a personal loyalty room based on userId or storeId.
     * This allows targeted updates.
     */
    @SubscribeMessage('joinLoyalty')
    handleJoinLoyalty(
        @ConnectedSocket() client: Socket,
        @MessageBody() payload: { targetId: string; role: 'CUSTOMER' | 'VENDOR' },
    ) {
        const room = `${payload.role}_${payload.targetId}`;
        client.join(room);
        this.logger.log(`Client ${client.id} joined loyalty room: ${room}`);
        return { event: 'joined', data: room };
    }

    /**
     * Notify user/merchant of a loyalty update
     */
    emitLoyaltyUpdate(targetId: string, role: 'CUSTOMER' | 'VENDOR', data: any) {
        const room = `${role}_${targetId}`;
        this.server.to(room).emit('loyaltyUpdated', data);
    }
}
