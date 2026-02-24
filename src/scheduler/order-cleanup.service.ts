import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStateMachine } from '../orders/fsm/order-state-machine.service';
import { OrdersService } from '../orders/orders.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStatus, ActorType } from '@prisma/client';

@Injectable()
export class OrderCleanupService {
    private readonly logger = new Logger(OrderCleanupService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly orderStateMachine: OrderStateMachine,
        private readonly ordersService: OrdersService,
        private readonly notificationsService: NotificationsService,
    ) { }

    // Run every 1 minute to check for expired orders for near real-time expirations
    @Cron(CronExpression.EVERY_MINUTE)
    async handleCron() {
        this.logger.debug('Running Order Cleanup Job...');
        await this.expireAwaitingOffers();
        await this.expireAwaitingPayment();
    }

    private async expireAwaitingOffers() {
        // Find orders in AWAITING_OFFERS created more than 24 hours ago
        const expiryDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const expiredOrders = await this.prisma.order.findMany({
            where: {
                status: OrderStatus.AWAITING_OFFERS,
                createdAt: {
                    lt: expiryDate,
                },
            },
            select: { id: true, orderNumber: true, customerId: true },
        });

        for (const order of expiredOrders) {
            try {
                this.logger.log(`Expiring order ${order.orderNumber} (ID: ${order.id})`);
                await this.ordersService.transitionStatus(
                    order.id,
                    OrderStatus.CANCELLED,
                    { type: ActorType.SYSTEM, id: 'system-scheduler', name: 'System Scheduler' },
                    'System: Order expired after 24 hours waiting for offers',
                );

                // Real-time Expiry Notification via WebSockets / Postgres Changes
                await this.notificationsService.create({
                    recipientId: order.customerId,
                    recipientRole: 'CUSTOMER',
                    titleAr: 'عذراً، طلبك لم يتلق عروض',
                    titleEn: 'Order Expired without Offers',
                    messageAr: `في هذا الطلب رقم (#${order.orderNumber})، انتهت مدة استلام العروض (24 ساعة). يمكنك دائماً إنشاء طلب جديد.`,
                    messageEn: `In order (#${order.orderNumber}), the time to receive offers has ended (24h). Please feel free to create a new request.`,
                    type: 'system_alert'
                });
            } catch (error) {
                this.logger.error(`Failed to expire order ${order.id}: ${error.message}`);
            }
        }
    }

    private async expireAwaitingPayment() {
        // Find orders in AWAITING_PAYMENT updated more than 24 hours ago
        const expiryDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const expiredOrders = await this.prisma.order.findMany({
            where: {
                status: OrderStatus.AWAITING_PAYMENT,
                updatedAt: { // Use updatedAt because creation might be older
                    lt: expiryDate,
                },
            },
            select: { id: true, orderNumber: true },
        });

        for (const order of expiredOrders) {
            try {
                this.logger.log(`Expiring unpaid order ${order.orderNumber} (ID: ${order.id})`);
                await this.ordersService.transitionStatus(
                    order.id,
                    OrderStatus.CANCELLED,
                    { type: ActorType.SYSTEM, id: 'system-scheduler', name: 'System Scheduler' },
                    'System: Payment period expired after 24 hours',
                );
            } catch (error) {
                this.logger.error(`Failed to expire order ${order.id}: ${error.message}`);
            }
        }
    }
}
