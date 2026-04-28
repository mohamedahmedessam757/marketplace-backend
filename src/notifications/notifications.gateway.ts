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

  afterInit(server: Server) {
    this.logger.log('Notifications WebSocket Gateway Initialized on namespace: /notifications');
  }

  handleConnection(client: Socket) {
    const { userId, role } = client.handshake.query;
    this.logger.log(`[NotificationsGateway] New connection attempt: ${client.id} (User: ${userId}, Role: ${role})`);

    if (userId) {
      client.join(`user_${userId}`);
      this.logger.log(`[NotificationsGateway] Client ${client.id} joined room: user_${userId}`);
    }
    
    // Admins join a special room for platform-wide alerts
    if (role === 'ADMIN' || role === 'SUPER_ADMIN') {
      client.join('admins');
      this.logger.log(`[NotificationsGateway] Admin ${client.id} joined room: admins`);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`[NotificationsGateway] Client disconnected: ${client.id}`);
  }

  /**
   * Sends a notification to a specific user room
   */
  sendToUser(userId: string, notification: any) {
    this.logger.log(`[NotificationsGateway] Emitting 'new_notification' to user_${userId}`);
    this.server.to(`user_${userId}`).emit('new_notification', notification);
  }

  /**
   * Sends a notification to all admins
   */
  sendToAdmins(notification: any) {
    this.logger.log(`[NotificationsGateway] Emitting 'admin_alert' to admins`);
    this.server.to('admins').emit('admin_alert', notification);
  }
}
