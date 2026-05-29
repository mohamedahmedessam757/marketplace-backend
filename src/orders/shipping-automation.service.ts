import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from './orders.service';
import { OrderStatus, ActorType } from '@prisma/client';
import { WaybillsService } from '../waybills/waybills.service';

@Injectable()
export class ShippingAutomationService {
    private readonly logger = new Logger(ShippingAutomationService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly ordersService: OrdersService,
        private readonly waybillsService: WaybillsService,
    ) {}

    /**
     * Safety net for transient failures: verified orders must not depend on a manual admin button.
     * The immediate issuance happens in the verification approval flow; this keeps the invariant true.
     */
    @Cron(CronExpression.EVERY_5_MINUTES)
    async handleVerifiedOrdersMissingWaybills() {
        const orders = await this.prisma.order.findMany({
            where: {
                status: OrderStatus.VERIFICATION_SUCCESS,
                requestType: { not: 'multiple' },
                shippingWaybills: { none: {} },
            },
            select: { id: true, orderNumber: true },
            take: 8,
        });

        for (const order of orders) {
            try {
                await this.waybillsService.autoIssueAfterVerificationSuccess(order.id, null);
                this.logger.log(`Auto-issued missing waybill for verified order ${order.orderNumber}`);
            } catch (error) {
                this.logger.error(
                    `Failed to auto-issue missing waybill for ${order.orderNumber}: ${error instanceof Error ? error.message : error}`,
                );
            }
        }
    }

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

            this.logger.log(`📦 Found ${agingOffers.length} aging items. Grouping by order...`);

            const byOrder = agingOffers.reduce(
                (acc, offer: { id: string; order: { id: string; customerId: string } }) => {
                    if (!acc[offer.order.id]) {
                        acc[offer.order.id] = {
                            customerId: offer.order.customerId,
                            offerIds: [] as string[],
                        };
                    }
                    acc[offer.order.id].offerIds.push(offer.id);
                    return acc;
                },
                {} as Record<string, { customerId: string; offerIds: string[] }>,
            );

            for (const { customerId, offerIds } of Object.values(byOrder)) {
                this.logger.log(
                    `🤖 Auto-shipping ${offerIds.length} item(s) for customer ${customerId} (one shipment per order batch)...`,
                );

                await this.ordersService.requestShipping(
                    customerId,
                    undefined,
                    offerIds,
                    true,
                );
            }

            this.logger.log('✨ Auto-shipping audit completed successfully.');
        } catch (error) {
            this.logger.error('❌ Error during auto-shipping audit:', error.stack);
        }
    }
}
