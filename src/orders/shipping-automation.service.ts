import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from './orders.service';
import { OrderStatus, ActorType } from '@prisma/client';

@Injectable()
export class ShippingAutomationService {
    private readonly logger = new Logger(ShippingAutomationService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly ordersService: OrdersService,
    ) {}

    /**
     * Runs every 6 hours to check for items that have been in the assembly cart for more than 7 days.
     * 2026 Logistics Standard: Automatic fulfillment to prevent warehouse congestion.
     */
    @Cron(CronExpression.EVERY_6_HOURS)
    async handleAutoShipping() {
        this.logger.log('🚀 Starting 7-day Auto-Shipping audit...');

        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        try {
            // Find offers that are:
            // 1. Accepted
            // 2. Not yet shipped from cart
            // 3. Paid more than 7 days ago
            const agingOffers = await this.prisma.offer.findMany({
                where: {
                    status: 'accepted',
                    shippedFromCart: false,
                    payments: {
                        some: {
                            status: 'SUCCESS',
                            paidAt: { lte: sevenDaysAgo }
                        }
                    },
                    // Only for orders in phases that support assembly cart
                    order: {
                        status: { in: [OrderStatus.PREPARATION, OrderStatus.PARTIALLY_SHIPPED, OrderStatus.VERIFICATION_SUCCESS] }
                    }
                },
                include: {
                    order: {
                        select: { id: true, customerId: true }
                    }
                }
            });

            if (agingOffers.length === 0) {
                this.logger.log('✅ No aging items found in assembly carts.');
                return;
            }

            this.logger.log(`📦 Found ${agingOffers.length} aging items. Grouping by customer...`);

            // Group by customer to minimize shipment records and notifications
            const byCustomer = agingOffers.reduce((acc, offer: any) => {
                const customerId = offer.order.customerId;
                if (!acc[customerId]) acc[customerId] = [];
                acc[customerId].push(offer.id);
                return acc;
            }, {} as Record<string, string[]>);

            for (const [customerId, offerIds] of Object.entries(byCustomer)) {
                this.logger.log(`🤖 Auto-shipping ${offerIds.length} items for customer ${customerId}...`);
                
                await this.ordersService.requestShipping(
                    customerId,
                    undefined, // No specific order IDs
                    offerIds,
                    true // isSystemAutoTrigger
                );
            }

            this.logger.log('✨ Auto-shipping audit completed successfully.');
        } catch (error) {
            this.logger.error('❌ Error during auto-shipping audit:', error.stack);
        }
    }
}
