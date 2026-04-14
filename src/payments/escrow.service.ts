import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { Prisma } from '@prisma/client';

export interface EscrowAmounts {
    merchantAmount: number;
    commissionAmount: number;
    shippingAmount: number;
    gatewayFee: number;
}

@Injectable()
export class EscrowService {
    private readonly logger = new Logger(EscrowService.name);

    constructor(
        private prisma: PrismaService,
        private stripeService: StripeService,
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
            }
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
    async releaseFunds(orderId: string, releaseCondition: 'CUSTOMER_CONFIRM' | 'AUTO_48H' | 'ADMIN_RELEASE'): Promise<void> {
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
        if (!order) throw new BadRequestException('Order missing');

        const store = await this.prisma.store.findUnique({ where: { id: order.storeId } });
        if (!store) throw new BadRequestException('Store missing');

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
        });
    }

    /**
     * 3. Freeze Funds (When a dispute is opened)
     */
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

                 // Credit Customer Balance if they used wallet, or track that card was refunded
                 // For now, Stripe handles the card refund directly to the customer's bank.
             }
        });
    }
}
