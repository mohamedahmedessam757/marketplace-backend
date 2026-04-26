import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus, ActorType } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class WarrantyExpirationService {
    private readonly logger = new Logger(WarrantyExpirationService.name);

    constructor(
        private prisma: PrismaService,
        private notifications: NotificationsService,
    ) { }

    /**
     * Runs every hour to check for expired warranties.
     * 2026 Best Practice: Automated state transitions to reduce manual oversight.
     */
    @Cron(CronExpression.EVERY_HOUR)
    async handleWarrantyExpiration() {
        this.logger.log('Checking for expired warranties...');

        const now = new Date();

        // 1. Find all active warranties that have passed their end date
        const expiredOrders = await this.prisma.order.findMany({
            where: {
                status: OrderStatus.WARRANTY_ACTIVE,
                warranty_end_at: {
                    lt: now,
                },
            },
            select: {
                id: true,
                orderNumber: true,
                customerId: true,
                acceptedOffer: {
                    select: {
                        store: {
                            select: {
                                ownerId: true,
                            },
                        },
                    },
                },
            },
        }) as any[]; // Temporary cast to bypass IDE sync issues while ensuring runtime correctness

        if (expiredOrders.length === 0) {
            this.logger.log('No expired warranties found.');
            return;
        }

        this.logger.log(`Found ${expiredOrders.length} expired warranties. Processing...`);

        // 2. Batch transition statuses and log audit trails
        for (const order of expiredOrders) {
            try {
                await this.prisma.$transaction(async (tx) => {
                    // Update Order Status
                    await tx.order.update({
                        where: { id: order.id },
                        data: {
                            status: OrderStatus.WARRANTY_EXPIRED,
                            updatedAt: now,
                        },
                    });

                    // Log Audit Action
                    // Note: System-triggered actions use SYSTEM actor type
                    await tx.auditLog.create({
                        data: {
                            orderId: order.id,
                            action: 'WARRANTY_EXPIRED',
                            entity: 'Order',
                            actorType: ActorType.SYSTEM,
                            previousState: OrderStatus.WARRANTY_ACTIVE,
                            newState: OrderStatus.WARRANTY_EXPIRED,
                            reason: 'Automatic warranty expiration by system worker.',
                            timestamp: now,
                        },
                    });
                });

                // 3. Notify Customer
                await this.notifications.create({
                    recipientId: order.customerId,
                    recipientRole: 'CUSTOMER',
                    titleAr: 'انتهت فترة الضمان 🛡️',
                    titleEn: 'Warranty Period Expired 🛡️',
                    messageAr: `لقد انتهت فترة الضمان الخاصة بطلبك رقم ${order.orderNumber}. نأمل أن تكون القطعة قد نالت رضاك.`,
                    messageEn: `The warranty period for your order #${order.orderNumber} has expired. We hope you are satisfied with the part.`,
                    type: 'ORDER',
                    link: `/dashboard/orders/${order.id}`,
                });

                // 4. Notify Merchant (Optional but good for transparency)
                if (order.acceptedOffer?.store?.ownerId) {
                    await this.notifications.create({
                        recipientId: order.acceptedOffer.store.ownerId,
                        recipientRole: 'MERCHANT',
                        titleAr: 'انتهاء مسؤولية الضمان',
                        titleEn: 'Warranty Liability Expired',
                        messageAr: `انتهت فترة الضمان للطلب رقم ${order.orderNumber}. تم تحديث حالة الطلب إلى (ضمان منتهي).`,
                        messageEn: `The warranty period for order #${order.orderNumber} has expired. Status updated to Warranty Expired.`,
                        type: 'ORDER',
                        link: `/merchant/orders/${order.id}`,
                    });
                }

                this.logger.log(`Successfully expired warranty for Order #${order.orderNumber}`);
            } catch (error) {
                this.logger.error(`Failed to process expiration for Order #${order.id}:`, error);
            }
        }
    }
}
