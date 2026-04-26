import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStatus } from '@prisma/client';

@Injectable()
export class WarrantySchedulerService {
    private readonly logger = new Logger(WarrantySchedulerService.name);

    constructor(
        private prisma: PrismaService,
        private notifications: NotificationsService,
    ) {}

    /**
     * Periodically checks for expired warranties (Every Hour).
     * Modern 2026 Logic: Automated state management for post-purchase lifecycle.
     */
    @Cron(CronExpression.EVERY_HOUR)
    async handleWarrantyExpiration() {
        this.logger.log('Starting automated warranty expiration check...');

        const now = new Date();

        // 1. Find orders in WARRANTY_ACTIVE that have passed their end date
        const expiredOrders = await (this.prisma.order.findMany({
            where: {
                status: OrderStatus.WARRANTY_ACTIVE,
                warranty_end_at: {
                    lt: now,
                },
            } as any,
            include: {
                customer: { select: { id: true, name: true } },
            },
        }) as any);

        if (expiredOrders.length === 0) {
            this.logger.log('No expired warranties found.');
            return;
        }

        this.logger.log(`Found ${expiredOrders.length} expired warranties. Processing...`);

        // 2. Transition each order to WARRANTY_EXPIRED
        for (const order of expiredOrders) {
            try {
                await this.prisma.order.update({
                    where: { id: order.id },
                    data: { 
                        status: OrderStatus.WARRANTY_EXPIRED,
                        updatedAt: now,
                    },
                });

                // 3. Notify Customer
                await this.notifications.create({
                    recipientId: order.customerId,
                    recipientRole: 'CUSTOMER',
                    titleAr: 'انتهاء فترة الضمان 🛡️',
                    titleEn: 'Warranty Period Expired 🛡️',
                    messageAr: `لقد انتهت فترة الضمان الخاصة بطلبك #${order.orderNumber}. نأمل أن تكون القطعة تعمل بشكل ممتاز!`,
                    messageEn: `The warranty period for your order #${order.orderNumber} has expired. We hope the part is working perfectly!`,
                    type: 'ORDER_UPDATE',
                    link: `/dashboard/orders/${order.id}`,
                });

                this.logger.log(`Order #${order.orderNumber} transitioned to WARRANTY_EXPIRED.`);
            } catch (error) {
                this.logger.error(`Failed to process warranty expiration for Order #${order.orderNumber}: ${error.message}`);
            }
        }

        this.logger.log('Automated warranty expiration check completed.');
    }
}
