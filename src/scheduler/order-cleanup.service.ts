import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStateMachine } from '../orders/fsm/order-state-machine.service';
import { OrdersService } from '../orders/orders.service';
import { OrderStatus, ActorType } from '@prisma/client';

@Injectable()
export class OrderCleanupService {
    private readonly logger = new Logger(OrderCleanupService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly orderStateMachine: OrderStateMachine,
        private readonly ordersService: OrdersService,
    ) { }

    // Run every 10 minutes to check for expired orders
    @Cron(CronExpression.EVERY_10_MINUTES)
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
            select: { id: true, orderNumber: true },
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
