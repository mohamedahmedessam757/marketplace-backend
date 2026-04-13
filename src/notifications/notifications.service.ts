import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateNotificationDto } from './dto/create-notification.dto';

@Injectable()
export class NotificationsService {
    constructor(private prisma: PrismaService) { }

    async create(data: CreateNotificationDto) {
        return this.prisma.notification.create({
            data,
        });
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

        const notifications = admins.map(admin => ({
            ...data,
            recipientId: admin.id,
            recipientRole: 'ADMIN',
            type: data.type || 'alert'
        }));

        return this.prisma.notification.createMany({
            data: notifications
        });
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
}
