import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { Prisma, ActorType } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

export interface EscrowAmounts {
    merchantAmount: number;
    commissionAmount: number;
    shippingAmount: number;
    gatewayFee: number;
}

import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class EscrowService {
    private readonly logger = new Logger(EscrowService.name);

    constructor(
        private prisma: PrismaService,
        private stripeService: StripeService,
        private notifications: NotificationsService,
        private auditLogs: AuditLogsService,
    ) {}

    /**
     * 1. Hold Funds (after customer pays, but before shipment is delivered)
     */
    async holdFunds(paymentId: string, orderId: string, storeId: string, amounts: EscrowAmounts, tx?: Prisma.TransactionClient): Promise<void> {
        const prisma = tx || this.prisma;
        
        // 1. Create Escrow transaction
        await prisma.escrowTransaction.create({
            data: {
                paymentId,
                orderId,
                merchantAmount: amounts.merchantAmount,
                commissionAmount: amounts.commissionAmount,
                shippingAmount: amounts.shippingAmount,
                gatewayFee: amounts.gatewayFee,
                status: 'HELD'
     } });

        // Audit Log (2026 Escrow Hold)
        await this.auditLogs.logAction({
            orderId,
            action: 'ESCROW_HELD',
            entity: 'EscrowTransaction',
            actorType: ActorType.SYSTEM,
            actorId: 'PAYMENT_PROCESSOR',
            metadata: { paymentId, amounts }
        });

        // 2. Increase Merchant's pending balance
        await prisma.store.update({
            where: { id: storeId },
            data: {
                pendingBalance: {
                    increment: amounts.merchantAmount
                }
            }
        });

        // Note: Platform wallet update for commission/fees is deferred until RELEASE.
    }

    /**
     * 2. Release Funds (after delivery confirmation or 48H auto-release)
     */
    async releaseFunds(orderId: string, releaseCondition: 'CUSTOMER_CONFIRM' | 'AUTO_48H' | 'ADMIN_RELEASE', adminId?: string): Promise<void> {
        const escrow = await this.prisma.escrowTransaction.findFirst({
            where: { orderId, status: 'HELD' }
        });

        if (!escrow) throw new NotFoundException('No HELD escrow transaction found for this order');

        const payment = await this.prisma.paymentTransaction.findFirst({
            where: { id: escrow.paymentId }
        });
        if (!payment) throw new BadRequestException('Payment transaction missing');

        const order = await this.prisma.order.findUnique({
             where: { id: orderId }
        });
        if (!order) throw new BadRequestException(`Order missing for ID: ${orderId}`);

        if (!order.storeId) {
            this.logger.error(`Order #${order.orderNumber} (ID: ${order.id}) has no storeId. Cannot release escrow.`);
            throw new BadRequestException(`Order has no associated storeId`);
        }

        const store = await this.prisma.store.findUnique({ where: { id: order.storeId } });
        if (!store) throw new BadRequestException(`Store missing for ID: ${order.storeId}`);

        if (!store.stripeAccountId) {
            throw new BadRequestException('Store has no connected Stripe account. Cannot release funds to Stripe.');
        }

        // --- Execute Stripe Transfer ---
        // We transfer merchantAmount. Shipping usually goes to the merchant if self-shipping or platform if platform-shipping.
        // Assuming here merchant handles shipping based on existing flow, so they get both.
        const transferAmount = Number(escrow.merchantAmount) + Number(escrow.shippingAmount);
        
        const transferResponse = await this.stripeService.createTransfer(
            transferAmount.toString(),
            'AED',
            store.stripeAccountId,
            orderId, // transfer_group
            { orderId, type: releaseCondition }
        );

        // --- Database Transaction ---
        await this.prisma.$transaction(async (tx) => {
            // 1. Update Escrow status
            await tx.escrowTransaction.update({
                where: { id: escrow.id },
                data: {
                    status: 'RELEASED',
                    releaseCondition,
                    releasedAt: new Date()
                }
            });

            // 2. Move Merchant pending to available
            await tx.store.update({
                where: { id: order.storeId },
                data: {
                    pendingBalance: { decrement: Number(escrow.merchantAmount) },
                    balance: { increment: Number(escrow.merchantAmount) } // This is their actual available balance
                }
            });

            // 3. Update Platform Wallet (Commission & Fees are now realized)
            await tx.platformWallet.updateMany({
                data: {
                    commissionBalance: { increment: Number(escrow.commissionAmount) },
                    feesBalance: { increment: Number(escrow.gatewayFee) },
                    totalRevenue: { increment: Number(escrow.commissionAmount) + Number(escrow.gatewayFee) }
                }
            });

            // 4. Update Payment Transaction
            await tx.paymentTransaction.update({
                where: { id: payment.id },
                data: {
                    stripeTransferId: transferResponse.id,
                    escrowStatus: 'RELEASED'
                }
            });
            
            // 5. Merchant Wallet Transaction Log
            const currentStore = await tx.store.findUnique({ where: { id: order.storeId } });
            const newBalance = Number(currentStore?.balance || 0);

            await tx.walletTransaction.create({
                data: {
                   userId: store.ownerId,
                   role: 'VENDOR',
                   type: 'CREDIT',
                   transactionType: 'payment',
                   amount: Number(escrow.merchantAmount),
                   balanceAfter: newBalance, 
                   escrowId: escrow.id,
                   description: `Escrow released for Order #${order.orderNumber}`
                }
            });

            // 6. Notify Merchant
            await this.notifications.create({
                recipientId: store.ownerId,
                recipientRole: 'VENDOR',
                type: 'payment',
                titleAr: 'تم تحرير الدفعة! 💸',
                titleEn: 'Funds Released! 💸',
                messageAr: `تم تحرير مبلغ ${escrow.merchantAmount} درهم للطلب #${order.orderNumber} وإضافته إلى رصيدك المتاح.`,
                messageEn: `Amount of AED ${escrow.merchantAmount} for Order #${order.orderNumber} has been released to your available balance.`,
                link: 'wallet',
                metadata: { orderId, amount: escrow.merchantAmount }
            });

            // 7. Notify Admin
            await this.notifications.notifyAdmins({
                titleAr: 'تحرير رصيد من الضمان 🔓',
                titleEn: 'Escrow Funds Released 🔓',
                messageAr: `تم تحرير مبلغ ${escrow.merchantAmount} درهم للطلب #${order.orderNumber}. الشرط: ${releaseCondition}`,
                messageEn: `AED ${escrow.merchantAmount} released for Order #${order.orderNumber}. Condition: ${releaseCondition}`,
                type: 'PAYMENT',
                link: `/admin/orders/${orderId}`,
                metadata: { orderId, amount: escrow.merchantAmount, condition: releaseCondition }
            });

            // 8. Notify Customer (Transparency)
            await this.notifications.create({
                recipientId: order.customerId,
                recipientRole: 'CUSTOMER',
                titleAr: 'تحديث الضمان: تم تحرير المبلغ 🔓',
                titleEn: 'Escrow Update: Funds Released 🔓',
                messageAr: `تم تحرير مبلغ الضمان الخاص بطلبك #${order.orderNumber} للتاجر بعد اكتمال الطلب.`,
                messageEn: `The escrow funds for your order #${order.orderNumber} have been released to the merchant.`,
                type: 'ORDER',
                link: `/dashboard/orders/${orderId}`
            });

            // Audit Log (2026 Escrow Release)
            await this.auditLogs.logAction({
                orderId,
                action: 'ESCROW_RELEASED',
                entity: 'EscrowTransaction',
                actorType: adminId ? ActorType.ADMIN : ActorType.SYSTEM,
                actorId: adminId || (releaseCondition === 'CUSTOMER_CONFIRM' ? order.customerId : 'ESCROW_SCHEDULER'),
                metadata: {
                    releaseCondition,
                    amount: escrow.merchantAmount,
                    stripeTransferId: transferResponse.id
                }
            });
        });
    }

    async freezeFunds(orderId: string, reason: string): Promise<void> {
        const escrow = await this.prisma.escrowTransaction.findFirst({
            where: { orderId, status: 'HELD' }
        });

        if (!escrow) throw new BadRequestException('Only HELD funds can be frozen');

        const order = await this.prisma.order.findUnique({ where: { id: orderId } });

        await this.prisma.$transaction(async (tx) => {
             await tx.escrowTransaction.update({
                 where: { id: escrow.id },
                 data: {
                     status: 'FROZEN',
                     frozenReason: reason
                 }
             });

             if(order) {
                 await tx.store.update({
                     where: { id: order.storeId },
                     data: {
                         pendingBalance: { decrement: Number(escrow.merchantAmount) },
                         frozenBalance: { increment: Number(escrow.merchantAmount) }
                     }
                 });

                 // 3. Notify Merchant about frozen funds
                 const store = await tx.store.findUnique({ where: { id: order.storeId }, select: { ownerId: true } });
                 if (store) {
                     await this.notifications.create({
                         recipientId: store.ownerId,
                         recipientRole: 'VENDOR',
                         type: 'system',
                         titleAr: 'تجميد رصيد مؤقت ❄️',
                         titleEn: 'Funds Frozen Temporarily ❄️',
                         messageAr: `تم تجميد مبلغ (${escrow.merchantAmount}) درهم للطلب #${order.orderNumber} بسبب وجود نزاع مفتوح. سيتم البت في الرصيد بعد حل النزاع.`,
                         messageEn: `AED ${escrow.merchantAmount} for Order #${order.orderNumber} has been frozen due to an active dispute. Funds will be decided after resolution.`,
                         link: `marketplace/orders/${order.id}`,
                         metadata: { orderId, amount: escrow.merchantAmount }
                     });
                 }
                 
                 // 4. Notify Admin about Frozen Funds
                 await this.notifications.notifyAdmins({
                     titleAr: 'تجميد رصيد في الضمان ❄️',
                     titleEn: 'Escrow Funds Frozen ❄️',
                     messageAr: `تم تجميد مبلغ ${escrow.merchantAmount} درهم للطلب #${order.orderNumber}. السبب: ${reason}`,
                     messageEn: `AED ${escrow.merchantAmount} frozen for Order #${order.orderNumber}. Reason: ${reason}`,
                     type: 'PAYMENT',
                     link: `/admin/orders/${orderId}`,
                     metadata: { orderId, amount: escrow.merchantAmount, reason }
                 });

                 // 5. Notify Customer about Frozen Funds
                 await this.notifications.create({
                     recipientId: order.customerId,
                     recipientRole: 'CUSTOMER',
                     titleAr: 'تحديث النزاع: تجميد المبلغ ❄️',
                     titleEn: 'Dispute Update: Funds Frozen ❄️',
                     messageAr: `تم تجميد مبلغ الطلب #${order.orderNumber} مؤقتاً في نظام الضمان لحين حل النزاع.`,
                     messageEn: `The funds for order #${order.orderNumber} have been frozen in escrow pending dispute resolution.`,
                     type: 'ORDER',
                     link: `/dashboard/orders/${orderId}`
                 });

                 // Audit Log (2026 Escrow Freeze)
                 await this.auditLogs.logAction({
                     orderId,
                     action: 'ESCROW_FROZEN',
                     entity: 'EscrowTransaction',
                     actorType: ActorType.SYSTEM,
                     actorId: 'DISPUTE_ENGINE',
                     reason,
                     metadata: { amount: escrow.merchantAmount }
                 });
             }
        });
    }

    /**
     * 4. Process Refund (Full/Partial) connected to Stripe
     */
    async processRefund(orderId: string, refundAmount: number, reason: string, faultParty: 'MERCHANT' | 'CUSTOMER' | 'LOGISTICS'): Promise<void> {
         // Simplified refund logic. Depending on faultParty, who eats the shipping/gateway fee?
         // Assuming Full Refund here for Escrow.
         const escrow = await this.prisma.escrowTransaction.findFirst({
            where: { orderId, status: { in: ['HELD', 'FROZEN'] } } // Only unreleased funds can be straight refunded easily
        });

        if (!escrow) throw new BadRequestException('Escrow not found or already released.');

        const payment = await this.prisma.paymentTransaction.findFirst({
            where: { id: escrow.paymentId }
        });

        if (!payment || !payment.stripePaymentId) {
             throw new BadRequestException('Stripe payment ID missing. Cannot refund.');
        }

        const refundResponse = await this.stripeService.createRefund(payment.stripePaymentId, refundAmount.toString());

        await this.prisma.$transaction(async (tx) => {
             await tx.escrowTransaction.update({
                 where: { id: escrow.id },
                 data: { status: 'REFUNDED' }
             });

             await tx.paymentTransaction.update({
                 where: { id: payment.id },
                 data: {
                     escrowStatus: 'REFUNDED',
                     status: 'REFUNDED', // Global status
                     refundedAmount: refundAmount,
                     refundedAt: new Date(),
                     refundReason: reason
                 }
             });

             const order = await tx.order.findUnique({ where: { id: orderId } });
             if (order) {
                 // Remove money from Merchant's pending/frozen since they didn't earn it
                 const updateData: any = {};
                 if (escrow.status === 'HELD') {
                     updateData.pendingBalance = { decrement: Number(escrow.merchantAmount) };
                 } else if (escrow.status === 'FROZEN') {
                     updateData.frozenBalance = { decrement: Number(escrow.merchantAmount) };
                 }

                 await tx.store.update({
                     where: { id: order.storeId },
                     data: updateData
                 });

                 // 4. Notify Merchant
                 const store = await tx.store.findUnique({ where: { id: order.storeId }, select: { ownerId: true } });
                 if (store) {
                     await this.notifications.create({
                         recipientId: store.ownerId,
                         recipientRole: 'VENDOR',
                         type: 'payment',
                         titleAr: 'تم استرجاع عملية دفع ⚠️',
                         titleEn: 'Payment Refunded ⚠️',
                         messageAr: `تم استرجاع مبلغ ${refundAmount} درهم من الطلب #${order.orderNumber}. السبب: ${reason}`,
                         messageEn: `AED ${refundAmount} has been refunded for Order #${order.orderNumber}. Reason: ${reason}`,
                         link: `marketplace/orders/${order.id}`,
                         metadata: { orderId, amount: refundAmount }
                     });
                 }
             }

             // 5. Notify Customer
             await this.notifications.create({
                 recipientId: payment.customerId,
                 recipientRole: 'CUSTOMER',
                 type: 'payment',
                 titleAr: 'تم استرداد المبلغ 💰',
                 titleEn: 'Refund Processed 💰',
                 messageAr: `تم استرداد مبلغ ${refundAmount} درهم للطلب #${order?.orderNumber}. قد يستغرق ظهور المبلغ في حسابك البنكي عدة أيام عمل.`,
                 messageEn: `A refund of AED ${refundAmount} for Order #${order?.orderNumber} has been processed. It may take a few business days to appear in your account.`,
                 link: 'orders',
                 metadata: { orderId, amount: refundAmount }
             });

             // 6. Notify Admin about Refund
             await this.notifications.notifyAdmins({
                 titleAr: 'استرداد مبلغ مالي 💰',
                 titleEn: 'Refund Processed 💰',
                 messageAr: `تم استرداد مبلغ ${refundAmount} درهم للطلب #${order?.orderNumber}. السبب: ${reason}`,
                 messageEn: `AED ${refundAmount} refunded for Order #${order?.orderNumber}. Reason: ${reason}`,
                 type: 'PAYMENT',
                 link: `/admin/orders/${orderId}`,
                 metadata: { orderId, amount: refundAmount, reason }
             });

            // Audit Log (2026 Escrow Refund)
            await this.auditLogs.logAction({
                orderId,
                action: 'ESCROW_REFUNDED',
                entity: 'EscrowTransaction',
                actorType: ActorType.SYSTEM,
                actorId: 'REFUND_PROCESSOR',
                reason,
                metadata: { 
                    refundAmount, 
                    stripeRefundId: refundResponse.id,
                    faultParty
                }
            });
        });
    }
}
