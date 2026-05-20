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

/** Stripe refund completed; DB ledger applied in a separate short transaction. */
export interface StripeRefundContext {
    orderId: string;
    refundAmount: number;
    cappedFrom?: number;
    stripeRefundId: string;
    escrowId: string;
    paymentId: string;
    escrowHeldStatus: string;
    merchantAmount: number;
    customerId: string;
    reason: string;
    faultParty: 'MERCHANT' | 'CUSTOMER' | 'LOGISTICS';
    paymentTotalAmount: number;
    priorRefunded: number;
    orderNumber?: string;
    adjudicationLedger?: {
        caseId: string;
        caseType: 'return' | 'dispute';
        faultParty: string;
        feeBearer: string;
        grossPaid: number;
        platformFees: number;
        shippingDeducted: number;
        shippingCompanyLiability: number;
    };
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
        }, tx);

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
            where: { id: escrow.paymentId },
            include: { offer: { include: { store: true } } }
        });
        if (!payment || !payment.offer) throw new BadRequestException('Payment or Offer missing for escrow');

        const order = await this.prisma.order.findUnique({
             where: { id: orderId }
        });
        if (!order) throw new BadRequestException(`Order missing for ID: ${orderId}`);

        // 2026 Resilient Lookup: Use Store from the Offer (Multi-part support)
        const store = payment.offer.store;
        if (!store) {
            this.logger.error(`Offer #${payment.offer.offerNumber} has no associated store. Cannot release escrow.`);
            throw new BadRequestException(`Store missing for offer`);
        }

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
                where: { id: store.id },
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
            const currentStore = await tx.store.findUnique({ where: { id: store.id } });
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
     * Resolve escrow + payment for refunds (HELD first, then RELEASED/REFUNDED, then latest payment).
     */
    async resolvePaymentForRefund(orderId: string): Promise<{
        escrow: {
            id: string;
            status: string;
            merchantAmount: number;
            paymentId: string;
        } | null;
        payment: {
            id: string;
            stripePaymentId: string | null;
            totalAmount: number;
            refundedAmount: number;
            customerId: string;
        } | null;
    }> {
        let escrow = await this.prisma.escrowTransaction.findFirst({
            where: { orderId, status: { in: ['HELD', 'FROZEN'] } },
            orderBy: { createdAt: 'desc' },
        });

        if (!escrow) {
            escrow = await this.prisma.escrowTransaction.findFirst({
                where: {
                    orderId,
                    status: { in: ['RELEASED', 'REFUNDED', 'HELD', 'FROZEN'] },
                },
                orderBy: { createdAt: 'desc' },
            });
        }

        let payment = escrow?.paymentId
            ? await this.prisma.paymentTransaction.findUnique({
                  where: { id: escrow.paymentId },
              })
            : null;

        if (!payment) {
            payment = await this.prisma.paymentTransaction.findFirst({
                where: { orderId, status: { in: ['SUCCESS', 'REFUNDED'] } },
                orderBy: { paidAt: 'desc' },
            });
            if (!escrow && payment) {
                escrow = await this.prisma.escrowTransaction.findFirst({
                    where: { orderId, paymentId: payment.id },
                    orderBy: { createdAt: 'desc' },
                });
                if (!escrow) {
                    escrow = await this.prisma.escrowTransaction.findFirst({
                        where: { orderId },
                        orderBy: { createdAt: 'desc' },
                    });
                }
            }
        }

        return {
            escrow: escrow
                ? {
                      id: escrow.id,
                      status: escrow.status,
                      merchantAmount: Number(escrow.merchantAmount),
                      paymentId: escrow.paymentId,
                  }
                : null,
            payment: payment
                ? {
                      id: payment.id,
                      stripePaymentId: payment.stripePaymentId,
                      totalAmount: Number(payment.totalAmount),
                      refundedAmount: Number(payment.refundedAmount || 0),
                      customerId: payment.customerId,
                  }
                : null,
        };
    }

    /**
     * Authoritative paid amount for an order (from escrow-linked or latest SUCCESS payment).
     */
    async resolveOrderPaymentBase(
        orderId: string,
        txClient?: Prisma.TransactionClient,
    ): Promise<{
        paidTotal: number;
        alreadyRefunded: number;
        maxRefundableDb: number;
        stripePaymentId: string | null;
        paymentId: string | null;
    }> {
        const prisma = txClient || this.prisma;
        let escrow = await prisma.escrowTransaction.findFirst({
            where: { orderId, status: { in: ['HELD', 'FROZEN'] } },
            include: { payment: true },
            orderBy: { createdAt: 'desc' },
        });
        if (!escrow) {
            escrow = await prisma.escrowTransaction.findFirst({
                where: { orderId },
                include: { payment: true },
                orderBy: { createdAt: 'desc' },
            });
        }
        let payment = escrow?.payment ?? null;
        if (!payment) {
            payment = await prisma.paymentTransaction.findFirst({
                where: { orderId, status: { in: ['SUCCESS', 'REFUNDED'] } },
                orderBy: { paidAt: 'desc' },
            });
        }
        if (!payment) {
            return {
                paidTotal: 0,
                alreadyRefunded: 0,
                maxRefundableDb: 0,
                stripePaymentId: null,
                paymentId: null,
            };
        }
        const paidTotal = Number(payment.totalAmount);
        const alreadyRefunded = Number(payment.refundedAmount || 0);
        return {
            paidTotal,
            alreadyRefunded,
            maxRefundableDb: Math.max(0, paidTotal - alreadyRefunded),
            stripePaymentId: payment.stripePaymentId,
            paymentId: payment.id,
        };
    }

    /**
     * Cap refund to DB + Stripe remaining charge amount.
     */
    async resolveMaxRefundableAmount(
        orderId: string,
        txClient?: Prisma.TransactionClient,
    ): Promise<number> {
        const base = await this.resolveOrderPaymentBase(orderId, txClient);
        if (base.maxRefundableDb <= 0) return 0;
        if (!base.stripePaymentId) return base.maxRefundableDb;
        try {
            const stripeMax = await this.stripeService.getMaxRefundableAmountAed(base.stripePaymentId);
            return Math.min(base.maxRefundableDb, stripeMax);
        } catch (err: any) {
            this.logger.warn(
                `Stripe refundable lookup failed for order ${orderId}: ${err?.message}`,
            );
            return base.maxRefundableDb;
        }
    }

    /**
     * Stripe refund only — must run OUTSIDE long Prisma transactions (network I/O).
     */
    async executeStripeRefundOnly(
        orderId: string,
        refundAmount: number,
        reason: string,
        faultParty: 'MERCHANT' | 'CUSTOMER' | 'LOGISTICS',
    ): Promise<StripeRefundContext> {
        const resolved = await this.resolvePaymentForRefund(orderId);
        const payment = resolved.payment;
        const escrow = resolved.escrow;

        if (!payment) {
            throw new BadRequestException(
                'لا يوجد سجل دفع ناجح لهذا الطلب. لا يمكن تنفيذ الاسترداد.',
            );
        }
        if (!payment.stripePaymentId) {
            throw new BadRequestException('Stripe payment ID missing. Cannot refund.');
        }
        if (!escrow) {
            throw new BadRequestException(
                'لا يوجد سجل ضمان مرتبط بالطلب. راجع سجل الضمان ثم أعد المحاولة.',
            );
        }

        const maxRefundable = await this.resolveMaxRefundableAmount(orderId);
        const requested = Math.max(0, Number(refundAmount));
        const stripeAlreadyRefunded =
            Number(payment.refundedAmount || 0) === 0 && maxRefundable <= 0;

        let amountToRefund = requested;
        let refundResponse: { id: string };

        if (stripeAlreadyRefunded) {
            this.logger.warn(
                `Stripe shows order ${orderId} fully refunded but DB has refundedAmount=0. Syncing DB without a second Stripe call.`,
            );
            const stripeMax = await this.stripeService
                .getMaxRefundableAmountAed(payment.stripePaymentId!)
                .catch(() => 0);
            amountToRefund = Math.max(0, Number(payment.totalAmount) - stripeMax);
            refundResponse = { id: `db-sync-${Date.now()}` };
        } else {
            if (maxRefundable <= 0) {
                throw new BadRequestException(
                    'لا يوجد مبلغ متبقٍ قابل للاسترداد على عملية الدفع (ربما تم استرداد المبلغ بالكامل مسبقاً).',
                );
            }
            if (amountToRefund > maxRefundable) amountToRefund = maxRefundable;
            if (amountToRefund <= 0) {
                throw new BadRequestException('مبلغ الاسترداد يجب أن يكون أكبر من صفر.');
            }

            try {
                refundResponse = await this.stripeService.createRefund(
                    payment.stripePaymentId!,
                    amountToRefund.toFixed(2),
                );
            } catch (err: any) {
                throw new BadRequestException(
                    `تعذر تنفيذ الاسترداد عبر بوابة الدفع: ${err?.message || 'فشل استرداد Stripe'}`,
                );
            }
        }

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            select: { orderNumber: true },
        });

        return {
            orderId,
            refundAmount: amountToRefund,
            cappedFrom: requested > amountToRefund ? requested : undefined,
            stripeRefundId: refundResponse.id,
            escrowId: escrow.id,
            paymentId: payment.id,
            escrowHeldStatus: escrow.status,
            merchantAmount: escrow.merchantAmount,
            customerId: payment.customerId,
            reason,
            faultParty,
            paymentTotalAmount: payment.totalAmount,
            priorRefunded: payment.refundedAmount,
            orderNumber: order?.orderNumber,
        };
    }

    /** Fast DB ledger updates only (no Stripe, no notifications). */
    async applyRefundDbUpdates(
        tx: Prisma.TransactionClient,
        ctx: StripeRefundContext,
    ): Promise<void> {
        await tx.escrowTransaction.update({
            where: { id: ctx.escrowId },
            data: { status: 'REFUNDED' },
        });

        const totalRefunded = ctx.priorRefunded + ctx.refundAmount;
        await tx.paymentTransaction.update({
            where: { id: ctx.paymentId },
            data: {
                escrowStatus: 'REFUNDED',
                status: totalRefunded >= ctx.paymentTotalAmount ? 'REFUNDED' : 'SUCCESS',
                refundedAmount: totalRefunded,
                refundedAt: new Date(),
                refundReason: ctx.reason,
            },
        });

        const order = await tx.order.findUnique({
            where: { id: ctx.orderId },
            include: { acceptedOffer: { select: { storeId: true } } },
        });
        const storeId =
            order?.storeId ||
            order?.acceptedOffer?.storeId ||
            (
                await tx.dispute.findFirst({
                    where: { orderId: ctx.orderId },
                    select: { storeId: true },
                })
            )?.storeId;

        if (order && storeId) {
            const balanceUpdate: Prisma.StoreUpdateInput = {};
            if (ctx.escrowHeldStatus === 'HELD') {
                balanceUpdate.pendingBalance = { decrement: ctx.merchantAmount };
            } else if (ctx.escrowHeldStatus === 'FROZEN') {
                balanceUpdate.frozenBalance = { decrement: ctx.merchantAmount };
            } else if (ctx.escrowHeldStatus === 'RELEASED') {
                balanceUpdate.balance = { decrement: ctx.merchantAmount };
            }
            if (Object.keys(balanceUpdate).length > 0) {
                const storeBefore = await tx.store.findUnique({
                    where: { id: storeId },
                    select: { ownerId: true, balance: true },
                });
                await tx.store.update({ where: { id: storeId }, data: balanceUpdate });

                if (ctx.escrowHeldStatus === 'RELEASED' && storeBefore?.ownerId) {
                    const balanceAfter = Math.max(
                        0,
                        Number(storeBefore.balance) - ctx.merchantAmount,
                    );
                    await tx.walletTransaction.create({
                        data: {
                            userId: storeBefore.ownerId,
                            role: 'VENDOR',
                            type: 'DEBIT',
                            transactionType: 'refund',
                            amount: ctx.merchantAmount,
                            balanceAfter,
                            paymentId: ctx.paymentId,
                            description: `استرداد إداري — خصم من رصيد المتجر (طلب #${ctx.orderNumber || ctx.orderId})`,
                            metadata: {
                                orderId: ctx.orderId,
                                stripeRefundId: ctx.stripeRefundId,
                                clawback: true,
                                escrowStatus: ctx.escrowHeldStatus,
                            },
                        } as Prisma.WalletTransactionUncheckedCreateInput,
                    });
                }
            }
        }

        if (ctx.refundAmount > 0 && ctx.customerId) {
            const ledger = ctx.adjudicationLedger;
            const orderLabel = ctx.orderNumber || ctx.orderId;
            await tx.walletTransaction.create({
                data: {
                    userId: ctx.customerId,
                    role: 'CUSTOMER',
                    type: 'CREDIT',
                    transactionType: 'REFUND',
                    amount: ctx.refundAmount,
                    balanceAfter: 0,
                    paymentId: ctx.paymentId,
                    description: ledger
                        ? `استرداد نزاع/إرجاع — طلب #${orderLabel}`
                        : `Refund for Order #${orderLabel}`,
                    metadata: {
                        orderId: ctx.orderId,
                        stripeRefundId: ctx.stripeRefundId,
                        ...(ledger
                            ? {
                                  caseId: ledger.caseId,
                                  caseType: ledger.caseType,
                                  faultParty: ledger.faultParty,
                                  feeBearer: ledger.feeBearer,
                                  grossPaid: ledger.grossPaid,
                                  platformFees: ledger.platformFees,
                                  shippingDeducted: ledger.shippingDeducted,
                                  shippingCompanyLiability: ledger.shippingCompanyLiability,
                                  netRefunded: ctx.refundAmount,
                              }
                            : {}),
                    },
                } as Prisma.WalletTransactionUncheckedCreateInput,
            });
        }
    }

    /** Notifications + audit after DB commit (non-blocking). */
    dispatchRefundNotifications(ctx: StripeRefundContext): void {
        const orderNumber = ctx.orderNumber || ctx.orderId;
        const refundAmount = ctx.refundAmount;

        void (async () => {
            try {
                const order = await this.prisma.order.findUnique({
                    where: { id: ctx.orderId },
                    include: { acceptedOffer: { select: { storeId: true } } },
                });
                const storeId =
                    order?.storeId ||
                    order?.acceptedOffer?.storeId ||
                    (
                        await this.prisma.dispute.findFirst({
                            where: { orderId: ctx.orderId },
                            select: { storeId: true },
                        })
                    )?.storeId;

                if (storeId) {
                    const store = await this.prisma.store.findUnique({
                        where: { id: storeId },
                        select: { ownerId: true },
                    });
                    if (store) {
                        await this.notifications.create({
                            recipientId: store.ownerId,
                            recipientRole: 'VENDOR',
                            type: 'payment',
                            titleAr: 'تم استرجاع عملية دفع ⚠️',
                            titleEn: 'Payment Refunded ⚠️',
                            messageAr: `تم استرجاع مبلغ ${refundAmount} درهم من الطلب #${orderNumber}. السبب: ${ctx.reason}`,
                            messageEn: `AED ${refundAmount} has been refunded for Order #${orderNumber}. Reason: ${ctx.reason}`,
                            link: `marketplace/orders/${ctx.orderId}`,
                            metadata: { orderId: ctx.orderId, amount: refundAmount },
                        });
                    }
                }

                await this.notifications.create({
                    recipientId: ctx.customerId,
                    recipientRole: 'CUSTOMER',
                    type: 'payment',
                    titleAr: 'تم استرداد المبلغ 💰',
                    titleEn: 'Refund Processed 💰',
                    messageAr: `تم استرداد مبلغ ${refundAmount} درهم للطلب #${orderNumber}. قد يستغرق ظهور المبلغ في حسابك البنكي عدة أيام عمل.`,
                    messageEn: `A refund of AED ${refundAmount} for Order #${orderNumber} has been processed. It may take a few business days to appear in your account.`,
                    link: 'orders',
                    metadata: { orderId: ctx.orderId, amount: refundAmount },
                });

                await this.notifications.notifyAdmins({
                    titleAr: 'استرداد مبلغ مالي 💰',
                    titleEn: 'Refund Processed 💰',
                    messageAr: `تم استرداد مبلغ ${refundAmount} درهم للطلب #${orderNumber}. السبب: ${ctx.reason}`,
                    messageEn: `AED ${refundAmount} refunded for Order #${orderNumber}. Reason: ${ctx.reason}`,
                    type: 'PAYMENT',
                    link: `/admin/orders/${ctx.orderId}`,
                    metadata: { orderId: ctx.orderId, amount: refundAmount, reason: ctx.reason },
                });

                await this.auditLogs.logAction({
                    orderId: ctx.orderId,
                    action: 'ESCROW_REFUNDED',
                    entity: 'EscrowTransaction',
                    actorType: ActorType.SYSTEM,
                    actorId: 'REFUND_PROCESSOR',
                    reason: ctx.reason,
                    metadata: {
                        refundAmount,
                        stripeRefundId: ctx.stripeRefundId,
                        faultParty: ctx.faultParty,
                        cappedFrom: ctx.cappedFrom,
                    },
                });
            } catch (err: any) {
                this.logger.error(
                    `dispatchRefundNotifications failed for order ${ctx.orderId}: ${err?.message}`,
                );
            }
        })();
    }

    /**
     * Full refund flow (standalone): Stripe → short DB tx → async notifications.
     */
    async processRefund(
        orderId: string,
        refundAmount: number,
        reason: string,
        faultParty: 'MERCHANT' | 'CUSTOMER' | 'LOGISTICS',
        txClient?: Prisma.TransactionClient,
    ): Promise<{ amountRefunded: number; cappedFrom?: number }> {
        if (txClient) {
            throw new BadRequestException(
                'processRefund cannot run inside a transaction; use executeStripeRefundOnly + applyRefundDbUpdates.',
            );
        }

        const ctx = await this.executeStripeRefundOnly(orderId, refundAmount, reason, faultParty);
        await this.prisma.$transaction(
            (tx) => this.applyRefundDbUpdates(tx, ctx),
            { timeout: 15000 },
        );
        this.dispatchRefundNotifications(ctx);

        return { amountRefunded: ctx.refundAmount, cappedFrom: ctx.cappedFrom };
    }
}
