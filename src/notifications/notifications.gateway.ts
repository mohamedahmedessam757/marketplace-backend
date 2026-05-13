import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { extractSocketJwt, socketIoCorsOptions } from '../common/ws-socket.util';

@WebSocketGateway({
  cors: socketIoCorsOptions(),
  namespace: '/notifications',
})
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationsGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  afterInit(_server: Server) {}

  async handleConnection(client: Socket) {
    const token = extractSocketJwt(client);
    if (!token) {
      client.disconnect(true);
      return;
    }

    try {
      const payload = await this.jwtService.verifyAsync<{ sub: string }>(token);
      const dbUser = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, role: true },
      });
      if (!dbUser) {
        client.disconnect(true);
        return;
      }
      (client.data as { userId?: string }).userId = dbUser.id;
      client.join(`user_${dbUser.id}`);
      const r = dbUser.role?.toUpperCase();
      if (r === 'ADMIN' || r === 'SUPER_ADMIN' || r === 'SUPPORT') {
        client.join('admins');
      }
    } catch (e) {
      this.logger.warn(`Notifications WS auth failed: ${(e as Error).message}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(_client: Socket) {}

  sendToUser(userId: string, notification: any) {
    this.server.to(`user_${userId}`).emit('new_notification', notification);
  }

  sendToAdmins(notification: any) {
    this.server.to('admins').emit('admin_alert', notification);
  }
}
