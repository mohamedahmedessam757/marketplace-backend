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
import { JwtService } from '@nestjs/jwt';
import { LoyaltyService } from './loyalty.service';
import { PrismaService } from '../prisma/prisma.service';
import { extractSocketJwt, socketIoCorsOptions } from '../common/ws-socket.util';

@WebSocketGateway({
    cors: socketIoCorsOptions(),
    namespace: '/loyalty'
})
export class LoyaltyGateway implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit {
    @WebSocketServer()
    server: Server;

    private readonly logger = new Logger(LoyaltyGateway.name);

    constructor(
        @Inject(forwardRef(() => LoyaltyService))
        private readonly loyaltyService: LoyaltyService,
        private readonly jwtService: JwtService,
        private readonly prisma: PrismaService,
    ) { }

    afterInit(_server: Server) {
        this.logger.log('Loyalty WebSocket Gateway Initialized');
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
            this.logger.warn(`Loyalty WS auth failed: ${(e as Error).message}`);
            client.disconnect(true);
        }
    }

    handleDisconnect(_client: Socket) {
        this.logger.log('Client disconnected from Loyalty');
    }

    @SubscribeMessage('joinLoyalty')
    async handleJoinLoyalty(
        @ConnectedSocket() client: Socket,
        @MessageBody() payload: { targetId: string; role: 'CUSTOMER' | 'VENDOR' },
    ) {
        const userId = (client.data as { userId?: string }).userId;
        if (!userId) {
            return { event: 'error', message: 'Unauthorized' };
        }

        if (payload.role === 'CUSTOMER') {
            if (payload.targetId !== userId) {
                return { event: 'error', message: 'Forbidden' };
            }
        } else if (payload.role === 'VENDOR') {
            const store = await this.prisma.store.findUnique({
                where: { id: payload.targetId },
                select: { ownerId: true },
            });
            if (!store || store.ownerId !== userId) {
                return { event: 'error', message: 'Forbidden' };
            }
        } else {
            return { event: 'error', message: 'Invalid role' };
        }

        const room = `${payload.role}_${payload.targetId}`;
        client.join(room);
        this.logger.log(`Client ${client.id} joined loyalty room: ${room}`);
        return { event: 'joined', data: room };
    }

    emitLoyaltyUpdate(targetId: string, role: 'CUSTOMER' | 'VENDOR', data: any) {
        const room = `${role}_${targetId}`;
        this.server.to(room).emit('loyaltyUpdated', data);
    }
}
