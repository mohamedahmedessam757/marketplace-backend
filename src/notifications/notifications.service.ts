import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { NotificationsGateway } from './notifications.gateway';

@Injectable()
export class NotificationsService {
    private readonly logger = new Logger(NotificationsService.name);

    constructor(
        private prisma: PrismaService,
        private readonly gateway: NotificationsGateway
    ) { }

    async create(data: CreateNotificationDto) {
        // 1. Rate Limiting: Max 20 per hour per user
        if (await this.isRateLimited(data.recipientId)) {
            this.logger.warn(`Rate limit reached for user ${data.recipientId}. Notification suppressed.`);
            return null;
        }

        // 2. Role Fallback: Resolve from DB if not provided
        let recipientRole = data.recipientRole;
        if (!recipientRole) {
            const user = await this.prisma.user.findUnique({
                where: { id: data.recipientId },
                select: { role: true }
            });
            recipientRole = user?.role === 'VENDOR' ? 'MERCHANT' : user?.role || 'CUSTOMER';
        }

        // 3. Persist Notification
        const notification = await this.prisma.notification.create({
            data: {
                ...data,
                recipientRole,
            },
        });

        // 4. Real-time Emission
        this.gateway.sendToUser(data.recipientId, notification);

        return notification;
    }

    private async isRateLimited(userId: string): Promise<boolean> {
        const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
        const count = await this.prisma.notification.count({
            where: {
                recipientId: userId,
                createdAt: { gte: oneMinuteAgo }
            }
        });
        return count >= 20;
    }

    async findAll(userId: string) {
        return this.prisma.notification.findMany({
            where: { recipientId: userId },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });
    }

    async markAsRead(id: string, userId: string) {
        const notif = await this.prisma.notification.findUnique({ where: { id } });
        if (!notif || notif.recipientId !== userId) return null;

        return this.prisma.notification.update({
            where: { id },
            data: { isRead: true },
        });
    }

    async markAllAsRead(userId: string) {
        return this.prisma.notification.updateMany({
            where: { recipientId: userId, isRead: false },
            data: { isRead: true },
        });
    }

    async getUnreadCount(userId: string) {
        return this.prisma.notification.count({
            where: { recipientId: userId, isRead: false }
        });
    }

    /**
     * Helper to send urgent notifications to all platform administrators
     * Following 2026 Admin Alerting standards
     */
    async notifyAdmins(data: Omit<CreateNotificationDto, 'recipientId' | 'recipientRole'>) {
        const admins = await this.prisma.user.findMany({
            where: {
                role: { in: ['ADMIN', 'SUPER_ADMIN'] }
            },
            select: { id: true }
        });

        const notificationsData = admins.map(admin => ({
            ...data,
            recipientId: admin.id,
            recipientRole: 'ADMIN',
            type: data.type || 'alert'
        }));

        // Use transaction for consistency
        const result = await this.prisma.notification.createMany({
            data: notificationsData
        });

        // Emit to admins room
        this.gateway.sendToAdmins({
            ...data,
            type: data.type || 'alert',
            createdAt: new Date()
        });

        return result;
    }

    /**
     * Standardized helper for bilingual user notifications
     */
    async notifyUser(recipientId: string, role: string, data: Omit<CreateNotificationDto, 'recipientId' | 'recipientRole'>) {
        return this.create({
            ...data,
            recipientId,
            recipientRole: role,
            type: data.type || 'system'
        });
    }

    /**
     * Phase 1 Enhancement: Auto-resolve store owner from storeId
     */
    async notifyMerchantByStoreId(storeId: string, data: Omit<CreateNotificationDto, 'recipientId' | 'recipientRole'>) {
        const store = await this.prisma.store.findUnique({
            where: { id: storeId },
            select: { ownerId: true }
        });

        if (!store) {
            this.logger.error(`Failed to notify merchant: Store ${storeId} not found.`);
            return null;
        }

        return this.notifyUser(store.ownerId, 'MERCHANT', data);
    }

    /**
     * Phase 1 Enhancement: Prevent duplicate notifications within a TTL window
     */
    async notifyWithDedup(recipientId: string, dedupKey: string, ttlMinutes: number, data: CreateNotificationDto) {
        const recent = await this.prisma.notification.findFirst({
            where: {
                recipientId,
                type: data.type,
                createdAt: { gte: new Date(Date.now() - ttlMinutes * 60000) },
                metadata: {
                    path: ['dedupKey'],
                    equals: dedupKey
                }
            }
        });

        if (recent) {
            this.logger.debug(`Duplicate notification suppressed for user ${recipientId} (key: ${dedupKey})`);
            return recent;
        }

        return this.create({
            ...data,
            metadata: { ...data.metadata, dedupKey }
        });
    }
}
