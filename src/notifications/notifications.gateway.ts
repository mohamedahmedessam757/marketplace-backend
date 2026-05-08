import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
  namespace: '/notifications'
})
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationsGateway.name);

  afterInit(server: Server) {}

  handleConnection(client: Socket) {
    const { userId, role } = client.handshake.query;

    if (userId) {
      client.join(`user_${userId}`);
    }
    
    // Admins join a special room for platform-wide alerts
    if (role === 'ADMIN' || role === 'SUPER_ADMIN') {
      client.join('admins');
    }
  }

  handleDisconnect(client: Socket) {}

  /**
   * Sends a notification to a specific user room
   */
  sendToUser(userId: string, notification: any) {
    this.server.to(`user_${userId}`).emit('new_notification', notification);
  }

  /**
   * Sends a notification to all admins
   */
  sendToAdmins(notification: any) {
    this.server.to('admins').emit('admin_alert', notification);
  }
}
