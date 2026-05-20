import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StripeService } from '../stripe/stripe.service';
import { ProcessPaymentDto } from './dto/process-payment.dto';
import { CreateIntentDto } from './dto/create-intent.dto';
import { AdminManualPayoutDto, PayoutMethod } from './dto/admin-payout.dto';
import { Prisma, ActorType, OfferFulfillmentStatus } from '@prisma/client';
import { EscrowService } from './escrow.service';
import { UnifiedFinancialEventDto, FinancialEventSource, FinancialDirection } from './dto/unified-financial-feed.dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { OfferFulfillmentService } from '../orders/offer-fulfillment.service';

@Injectable()
export class PaymentsService {
    private readonly logger = new Logger(PaymentsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly notifications: NotificationsService,
        private readonly escrowService: EscrowService,
        @Inject(forwardRef(() => StripeService))
        private readonly stripeService: StripeService,
        private readonly auditLogs: AuditLogsService,
        @Inject(forwardRef(() => OfferFulfillmentService))
        private readonly offerFulfillment: OfferFulfillmentService,
    ) { }

    /**
     * Process a payment for a single offer within an order.
     * This is the core payment logic implementing:
     * 1. Ownership & status validation
     * 2. Commission calculation (25% of unitPrice, min 100 AED)
     * 3. Payment transaction recording
     * 4. Wallet distribution (merchant gets unitPrice+shipping, admin gets commission)
     * 5. Invoice generation
     * 6. Conditional order status transition (only if ALL accepted offers are paid)
     * 7. Notifications
     */
    async processPayment(customerId: string, dto: ProcessPaymentDto) {
        if (process.env.ALLOW_MOCK_PAYMENTS !== 'true') {
            throw new ForbiddenException('Mock payment API is disabled. Use Stripe.');
        }

        const { orderId, offerId, card } = dto;

        // 1. Fetch and validate order
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: {
                offers: {
                    where: { status: 'accepted' },
                    include: { store: true },
                },
            },
        });

        if (!order) throw new NotFoundException('Order not found');
        if (order.customerId !== customerId) throw new ForbiddenException('Not owner of this order');
        
        const validPaymentStatuses = ['AWAITING_PAYMENT', 'AWAITING_OFFERS', 'COLLECTING_OFFERS', 'AWAITING_SELECTION', 'PARTIALLY_PAID'];
        if (!validPaymentStatuses.includes(order.status)) {
            throw new BadRequestException(`Order is not in a valid payment status (Current: ${order.status})`);
        }

        // 2. Find the specific accepted offer AND validate it belongs to this order
        const offer = order.offers.find(o => o.id === offerId);
        if (!offer) {
            this.logger.warn(`Offer ${offerId} not found on order ${orderId}. Possible stale orderId.`);
            throw new NotFoundException(
                `Offer ${offerId} does not belong to order ${orderId}. Please refresh and try again.`,
            );
        }

        // 3. Fast-path guard: Check if this offer is already paid (soft check before DB constraint)
        const existingPayment = await this.prisma.paymentTransaction.findFirst({
            where: { offerId, status: 'SUCCESS' },
        });
        if (existingPayment) {
            throw new ConflictException('This offer has already been paid');
        }

        // 4. Calculate amounts
        const unitPrice = Number(offer.unitPrice);
        const shippingCost = Number(offer.shippingCost);
        const percentCommission = Math.round(unitPrice * 0.25);
        const commission = unitPrice > 0 ? Math.max(percentCommission, 100) : 0;
        const totalAmount = unitPrice + shippingCost + commission;

        // 5. Validate card (basic — in production this would be Stripe)
        const cardNumber = card.number.replace(/\s/g, '');
        if (cardNumber.length < 13 || cardNumber.length > 19) {
            throw new BadRequestException('Invalid card number');
        }

        // 6. Determine card brand
        const cardBrand = this.detectCardBrand(cardNumber);
        const cardLast4 = cardNumber.slice(-4);

        // 7. Execute atomic transaction (wrapped in try/catch for unique constraint safety)
        let result;
        try {
            result = await this.prisma.$transaction(async (tx) => {
                // 7a. Generate transaction number
                const txnResult = await tx.$queryRaw<{ generate_transaction_number: string }[]>`SELECT generate_transaction_number()`;
                const transactionNumber = txnResult[0].generate_transaction_number;

                // 7b. Create payment transaction with SUCCESS
                const payment = await tx.paymentTransaction.create({
                    data: {
                        transactionNumber,
                        orderId,
                        offerId,
                        customerId,
                        unitPrice,
                        shippingCost,
                        commission,
                        totalAmount,
                        currency: 'AED',
                        cardLast4,
                        cardBrand,
                        cardHolder: card.holder.toUpperCase(),
                        status: 'SUCCESS',
                        paidAt: new Date(),
                    },
                });

                await tx.offer.update({
                    where: { id: offerId },
                    data: { fulfillmentStatus: OfferFulfillmentStatus.IN_PREPARATION },
                });

                // 7b-i. Note: TotalSpent and LoyaltyPoints are now updated upon Order COMPLETION 
                // in OrdersService/LoyaltyService to ensure return period has passed.


                // 7c. Credit merchant wallet (unitPrice + shippingCost)
                const merchantAmount = unitPrice + shippingCost;
                const store = offer.store;

                if (store) {
                    const newStoreBalance = Number(store.balance) + merchantAmount;

                    await tx.store.update({
                        where: { id: store.id },
                        data: { balance: newStoreBalance },
                    });

                    await tx.walletTransaction.create({
                        data: {
                            userId: store.ownerId,
                            role: 'VENDOR',
                            paymentId: payment.id,
                            type: 'CREDIT',
                            amount: merchantAmount,
                            currency: 'AED',
                            description: `Payment for offer #${offer.offerNumber} — Order #${order.orderNumber}`,
                            balanceAfter: newStoreBalance,
                        },
                    });
                }

                // 7d. Credit admin commission (to a system wallet record)
                await tx.walletTransaction.create({
                    data: {
                        userId: customerId, // placeholder: in production use ADMIN user ID
                        role: 'ADMIN',
                        paymentId: payment.id,
                        type: 'CREDIT',
                        amount: commission,
                        currency: 'AED',
                        description: `Commission for offer #${offer.offerNumber} — Order #${order.orderNumber}`,
                        balanceAfter: commission, // placeholder — in production track admin balance
                    },
                });

                // 7e. Generate invoice
                const invResult = await tx.$queryRaw<{ generate_invoice_number: string }[]>`SELECT generate_invoice_number()`;
                const invoiceNumber = invResult[0].generate_invoice_number;

                await tx.invoice.create({
                    data: {
                        invoiceNumber,
                        orderId,
                        paymentId: payment.id,
                        customerId,
                        subtotal: unitPrice,
                        shipping: shippingCost,
                        commission,
                        total: totalAmount,
                        currency: 'AED',
                        status: 'PAID',
                    },
                });

                // 7f. Check if ALL accepted offers are now paid
                const allAcceptedOfferIds = order.offers.map(o => o.id);
                const paidCount = await tx.paymentTransaction.count({
                    where: {
                        offerId: { in: allAcceptedOfferIds },
                        status: 'SUCCESS',
                    },
                });

                const allPaid = paidCount >= allAcceptedOfferIds.length;
                const orderTransitioned = false;

                // Audit Log (2026 Payment Success)
                await this.auditLogs.logAction({
                    orderId,
                    action: 'PAYMENT_SUCCESS',
                    entity: 'PaymentTransaction',
                    actorType: ActorType.CUSTOMER,
                    actorId: customerId,
                    metadata: {
                        offerId,
                        transactionNumber,
                        amount: totalAmount,
                        commission,
                        orderTransitioned
                    },
                    newState: 'SUCCESS'
                }, tx);

                return {
                    payment,
                    invoiceNumber,
                    transactionNumber,
                    allPaid,
                    orderTransitioned,
                    remainingOffers: allAcceptedOfferIds.length - paidCount,
                };
            }, { timeout: 20000 });
        } catch (error) {
            // Handle Prisma unique constraint violation (race condition safety net)
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                this.logger.warn(`Duplicate payment attempt for offer ${offerId} caught by DB constraint`);
                throw new ConflictException('This offer has already been paid (duplicate detected)');
            }
            throw error; // Re-throw any other errors
        }

        try {
            const aggStatus = await this.offerFulfillment.recomputeOrderStatus(orderId);
            result.orderTransitioned = aggStatus === 'PREPARATION';
        } catch (recomputeErr: any) {
            this.logger.warn(
                `Fulfillment recompute after mock payment failed: ${recomputeErr?.message}`,
            );
        }

        // 8. Send notifications (outside transaction for performance)
        try {
            // Notify customer with "Premium" encouraging tone
            await this.notifications.create({
                recipientId: customerId,
                recipientRole: 'CUSTOMER',
                type: 'payment',
                titleAr: 'تم الدفع بنجاح! 🎉',
                titleEn: 'Payment Successful! 🎉',
                messageAr: `اختيار رائع! 👌 تم دفع ${totalAmount} درهم بنجاح للعرض #${offer.offerNumber}. نحن الآن بصدد البدء في تجهيز طلبك.`,
                messageEn: `Great choice! 👌 Payment of AED ${totalAmount} successful for offer #${offer.offerNumber}. We are now starting to prepare your order.`,
                link: 'checkout',
                metadata: { orderId, offerId, amount: totalAmount },
            });

            // Notify merchant with professional financial alert
            if (offer.store) {
                await this.notifications.create({
                    recipientId: offer.store.ownerId,
                    recipientRole: 'VENDOR',
                    type: 'payment',
                    titleAr: 'مبيعة جديدة! 💰',
                    titleEn: 'New Sale! 💰',
                    messageAr: `ممتاز! تم دفع الطلب #${order.orderNumber}. المبلغ المضاف لحسابك: ${unitPrice + shippingCost} درهم. يرجى البدء في التجهيز.`,
                    messageEn: `Excellent! Payment received for Order #${order.orderNumber}. Amount credited: AED ${unitPrice + shippingCost}. Please start preparation.`,
                    link: 'active-orders',
                    metadata: { orderId, amount: unitPrice + shippingCost },
                });
            }
        } catch (notifError) {
            // Don't fail the payment if notification fails
            console.error('Notification error after payment:', notifError);
        }

        return {
            success: true,
            transactionNumber: result.transactionNumber,
            invoiceNumber: result.invoiceNumber,
            totalAmount,
            allPaid: result.allPaid,
            orderTransitioned: result.orderTransitioned,
            remainingOffers: result.remainingOffers,
        };
    }
    
    /**
     * Phase 1: Create a Stripe PaymentIntent for the frontend to confirm.
     * This registers a PENDING transaction and returns the clientSecret.
     */
    async createPaymentIntent(customerId: string, dto: CreateIntentDto) {
        const { orderId, offerId } = dto;

        // 1. Fetch and validate order
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: {
                offers: {
                    where: { id: offerId, status: 'accepted' },
                    include: { store: true },
                },
            },
        });

        if (!order) throw new NotFoundException('Order not found');
        if (order.customerId !== customerId) throw new ForbiddenException('Not owner of this order');
        const validPaymentStatuses = ['AWAITING_PAYMENT', 'AWAITING_OFFERS', 'COLLECTING_OFFERS', 'AWAITING_SELECTION', 'PARTIALLY_PAID'];
        if (!validPaymentStatuses.includes(order.status)) {
            throw new BadRequestException(`Order is not in a valid payment status (Current: ${order.status})`);
        }

        const offer = order.offers[0];
        if (!offer) {
            throw new NotFoundException(`Accepted offer ${offerId} not found on order ${orderId}`);
        }

        // 2. Check existing payment row (SUCCESS blocks; PENDING may be reused)
        const existingPayment = await this.prisma.paymentTransaction.findUnique({
            where: { offerId },
        });
        if (existingPayment?.status === 'SUCCESS') {
            throw new ConflictException('This offer has already been paid');
        }

        // 3. Calculate amounts (Simplified: Offer Price is ALL-INCLUSIVE)
        const unitPrice = Number(offer.unitPrice);
        const shippingCost = Number(offer.shippingCost);
        const percentCommission = Math.round(unitPrice * 0.25);
        const commission = unitPrice > 0 ? Math.max(percentCommission, 100) : 0;
        
        // Total amount charged to customer = unitPrice + shippingCost + commission (Full price from OfferCard)
        const totalAmount = unitPrice + shippingCost + commission;
        const amountCents = Math.round(totalAmount * 100);

        // 4. Handle Stripe Customer (2026 Saved Card Logic)
        const user = await this.prisma.user.findUnique({
            where: { id: customerId },
            select: { email: true, name: true }
        });
        const stripeCustomerId = await this.stripeService.getOrCreateCustomer(customerId, user.email, user.name);

        const intentMetadata = {
            orderId,
            offerId,
            customerId,
            orderNumber: order.orderNumber,
            offerNumber: offer.offerNumber,
        };

        // 5. Stripe PaymentIntent — reuse open PENDING intent when possible (avoids duplicate intents on retry)
        let intent = await this.resolveOrCreateStripeIntent(
            existingPayment?.stripePaymentId,
            existingPayment?.status,
            Number(existingPayment?.totalAmount ?? 0),
            totalAmount,
            amountCents,
            intentMetadata,
            stripeCustomerId,
        );

        // 6. Record PENDING transaction — atomic upsert (race-safe vs concurrent prefetch + pay clicks)
        const isNewPaymentRow = !existingPayment;
        try {
            await this.prisma.$transaction(async (tx) => {
                const txnResult = await tx.$queryRaw<{ generate_transaction_number: string }[]>`SELECT generate_transaction_number()`;
                const transactionNumber = txnResult[0].generate_transaction_number;

                await tx.paymentTransaction.upsert({
                    where: { offerId },
                    create: {
                        transactionNumber,
                        orderId,
                        offerId,
                        customerId,
                        unitPrice,
                        shippingCost,
                        commission,
                        totalAmount,
                        currency: 'AED',
                        stripePaymentId: intent.id,
                        status: 'PENDING',
                    },
                    update: {
                        stripePaymentId: intent.id,
                        status: 'PENDING',
                        totalAmount,
                        unitPrice,
                        shippingCost,
                        commission,
                    },
                });

                if (isNewPaymentRow) {
                    await this.auditLogs.logAction({
                        orderId,
                        action: 'PAYMENT_INTENT_CREATED',
                        entity: 'PaymentTransaction',
                        actorType: ActorType.CUSTOMER,
                        actorId: customerId,
                        metadata: {
                            offerId,
                            amount: totalAmount,
                            stripeIntentId: intent.id,
                        },
                    }, tx);
                }
            }, { timeout: 20000 });
        } catch (error) {
            // Safety net: concurrent requests can still race before upsert lands (extremely rare)
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                this.logger.warn(
                    `Payment intent race on offer ${offerId} — reconciling with update instead of failing`,
                );
                await this.prisma.paymentTransaction.update({
                    where: { offerId },
                    data: {
                        stripePaymentId: intent.id,
                        status: 'PENDING',
                        totalAmount,
                        unitPrice,
                        shippingCost,
                        commission,
                    },
                });
            } else {
                throw error;
            }
        }

        return {
            clientSecret: intent.client_secret,
            paymentIntentId: intent.id,
            totalAmount,
            currency: 'AED'
        };
    }

    /**
     * Phase 2: Create a Stripe PaymentIntent for RETURN/DISPUTE shipping costs.
     */
    async createShippingPaymentIntent(userId: string, caseId: string, caseType: 'return' | 'dispute') {
        const model = caseType === 'return' ? this.prisma.returnRequest : this.prisma.dispute;
        
        const caseRecord = await (model as any).findUnique({
            where: { id: caseId },
            include: { 
                store: true,
                order: true 
            }
        });

        if (!caseRecord) throw new NotFoundException('Case not found');
        
        // Validation: Is this user the one obligated to pay?
        const isMerchant = caseRecord.shippingPayee === 'MERCHANT';
        const isCustomer = caseRecord.shippingPayee === 'CUSTOMER';
        
        if (isMerchant) {
            const store = await this.prisma.store.findUnique({ where: { ownerId: userId } });
            if (!store || store.id !== caseRecord.storeId) {
                throw new ForbiddenException('You are not the merchant assigned to this shipping payment');
            }
        } else if (isCustomer) {
            if (caseRecord.customerId !== userId) {
                throw new ForbiddenException('You are not the customer assigned to this shipping payment');
            }
        } else {
            throw new BadRequestException('No shipping payee assigned to this case');
        }

        const shippingAmount = Number(caseRecord.shippingRefund || 0);
        if (shippingAmount <= 0) throw new BadRequestException('No shipping cost to pay');
        
        if (caseRecord.shippingPaymentStatus === 'PAID') {
            throw new BadRequestException('Shipping already paid');
        }

        // Create Stripe Intent
        const intent = await this.stripeService.createPaymentIntent(
            shippingAmount.toString(),
            'AED',
            {
                caseId,
                caseType,
                isShippingPayment: 'true',
                orderId: caseRecord.orderId,
                orderNumber: caseRecord.order?.orderNumber
            }
        );

        // Record intent ID in the case record
        await (model as any).update({
            where: { id: caseId },
            data: { shippingStripeId: intent.id }
        });

        return {
            clientSecret: intent.client_secret,
            paymentIntentId: intent.id,
            amount: shippingAmount,
            currency: 'AED'
        };
    }
    async createShippingCheckoutSession(userId: string, caseId: string, caseType: 'return' | 'dispute', frontendUrl?: string) {
        const model = caseType === 'return' ? this.prisma.returnRequest : this.prisma.dispute;
        
        const caseRecord = await (model as any).findUnique({
            where: { id: caseId },
            include: { 
                customer: true,
                order: true 
            }
        });

        if (!caseRecord) throw new NotFoundException('Case not found');
        
        // Validation
        const isMerchant = caseRecord.shippingPayee === 'MERCHANT';
        const isCustomer = caseRecord.shippingPayee === 'CUSTOMER';
        
        if (isMerchant) {
            const store = await this.prisma.store.findUnique({ where: { ownerId: userId } });
            if (!store || store.id !== caseRecord.storeId) {
                throw new ForbiddenException('You are not the merchant assigned to this shipping payment');
            }
        } else if (isCustomer) {
            if (caseRecord.customerId !== userId) {
                throw new ForbiddenException('You are not the customer assigned to this shipping payment');
            }
        }

        const shippingAmount = Number(caseRecord.shippingRefund || 0);
        if (shippingAmount <= 0) throw new BadRequestException('No shipping cost to pay');

        const baseUrl = (frontendUrl || process.env.FRONTEND_URL || 'http://localhost:5173').replace(
            /\/$/,
            '',
        );
        const returnPath =
            caseType === 'dispute'
                ? `/dashboard/dispute-details/${caseId}`
                : `/dashboard/resolution`;
        const successUrl = `${baseUrl}${returnPath}?payment=success&caseId=${caseId}&caseType=${caseType}`;
        const cancelUrl = `${baseUrl}${returnPath}?payment=cancel&caseId=${caseId}&caseType=${caseType}`;

        const session = await this.stripeService.createCheckoutSession({
            amount: shippingAmount.toString(),
            currency: 'AED',
            successUrl,
            cancelUrl,
            customerEmail: caseRecord.customer?.email,
            metadata: {
                caseId,
                caseType,
                isShippingPayment: 'true',
                orderId: caseRecord.orderId,
                orderNumber: caseRecord.order?.orderNumber
            }
        });

        // Record session ID in the case record for tracking
        await (model as any).update({
            where: { id: caseId },
            data: { shippingStripeId: session.id }
        });

        return { url: session.url };
    }

    /**
     * Phase 2: Webhook Fulfillment
     * Finalizes the payment, credits wallets, generates invoices, and holds funds in escrow.
     * Triggered by Stripe Webhook (payment_intent.succeeded)
     */
    async fulfillStripePayment(paymentIntentId: string) {
        // 1. Find the pending transaction
        const payment = await this.prisma.paymentTransaction.findFirst({
            where: { stripePaymentId: paymentIntentId }, // Removed redundant 'status: PENDING' to allow idempotency checks inside the transaction
            include: { 
                order: true, 
                offer: { 
                    include: { store: true } 
                } 
            }
        });

        if (!payment) {
            // Check if it's a shipping payment intent (these aren't in paymentTransaction table)
            const intent = await this.stripeService.getStripeClient().paymentIntents.retrieve(paymentIntentId);
            if (intent.metadata?.isShippingPayment === 'true') {
                return await this.fulfillShippingPayment(intent);
            }

            this.logger.warn(`Stripe payment fulfillment failed: Record not found for intent ${paymentIntentId}`);
            return;
        }

        const stripeClient = this.stripeService.getStripeClient();
        const intentSnapshot = await stripeClient.paymentIntents.retrieve(paymentIntentId);
        const expectedMinor = Math.round(Number(payment.totalAmount) * 100);
        if (
            intentSnapshot.status === 'succeeded' &&
            typeof intentSnapshot.amount_received === 'number' &&
            intentSnapshot.amount_received !== expectedMinor
        ) {
            this.logger.error(
                `Stripe amount mismatch for ${paymentIntentId}: expected ${expectedMinor}, received ${intentSnapshot.amount_received}`,
            );
            throw new Error('Stripe payment amount does not match recorded transaction');
        }

        // 2. Atomic Database Transaction
        const result = await this.prisma.$transaction(async (tx) => {
            // Re-check status inside transaction to prevent race conditions
            const txPayment = await tx.paymentTransaction.findUnique({
                where: { id: payment.id }
            });
            
            // Idempotency: skip if already successful
            if (txPayment?.status === 'SUCCESS') {
                this.logger.log(`Payment intent ${paymentIntentId} already fulfilled. Skipping.`);
                return;
            }

            // a. Mark Payment SUCCESS
            const updatedPayment = await tx.paymentTransaction.update({
                where: { id: payment.id },
                data: { 
                    status: 'SUCCESS', 
                    paidAt: new Date(),
                    gatewayFee: 0 
                }
            });

            await tx.offer.update({
                where: { id: payment.offerId },
                data: { fulfillmentStatus: OfferFulfillmentStatus.IN_PREPARATION },
            });

            // b. Execute Financial Flow (Wallet & Escrow)
            const unitPrice = Number(payment.unitPrice);
            const shippingCost = Number(payment.shippingCost);
            const commission = Number(payment.commission);
            
            // Merchant Net Share = unitPrice (the basePrice set by merchant)
            // Commission and shipping are ADDED on top and belong to the platform
            const merchantNetShare = unitPrice;

            // Hold funds in Escrow (using the shared tx client for atomicity)
            // Admin share consists of commission + shippingCost
            await this.escrowService.holdFunds(
                payment.id, 
                payment.orderId, 
                payment.offer.storeId, 
                {
                    merchantAmount: merchantNetShare,
                    shippingAmount: shippingCost,
                    commissionAmount: commission,
                    gatewayFee: 0
                },
                tx
            );

            // Credit Merchant Wallet (Create transaction record for net amount)
            await tx.walletTransaction.create({
                data: {
                    userId: payment.offer.store.ownerId,
                    role: 'VENDOR',
                    paymentId: payment.id,
                    type: 'CREDIT',
                    transactionType: 'payment',
                    amount: merchantNetShare,
                    currency: 'AED',
                    description: `Net payout for offer #${payment.offer.offerNumber} (Excludes Admin Commission & Shipping) — Order #${payment.order.orderNumber}`,
                    balanceAfter: Number(payment.offer.store.balance) + merchantNetShare
                }
            });

            // c. Generate Invoice
            const invResult = await tx.$queryRaw<{ generate_invoice_number: string }[]>`SELECT generate_invoice_number()`;
            const invoiceNumber = invResult[0].generate_invoice_number;

            await tx.invoice.create({
                data: {
                    invoiceNumber,
                    orderId: payment.orderId,
                    paymentId: payment.id,
                    customerId: payment.customerId,
                    subtotal: unitPrice,
                    shipping: shippingCost,
                    commission,
                    total: Number(payment.totalAmount),
                    currency: 'AED',
                    status: 'PAID',
                },
            });

            // d. Check if ALL accepted offers are now paid
            const allAcceptedOffers = await tx.offer.findMany({
                where: { orderId: payment.orderId, status: 'accepted' },
                select: { id: true }
            });
            
            const paidCount = await tx.paymentTransaction.count({
                where: { 
                    orderId: payment.orderId, 
                    status: 'SUCCESS' 
                }
            });

            const orderTransitioned = paidCount >= allAcceptedOffers.length;

            return {
                payment: updatedPayment,
                invoiceNumber,
                orderTransitioned,
                storeOwnerId: payment.offer.store.ownerId,
                totalAmount: Number(payment.totalAmount),
                offerNumber: payment.offer.offerNumber,
                orderNumber: payment.order.orderNumber,
                customerId: payment.customerId,
                orderId: payment.orderId,
                unitPrice,
                shippingCost
            };
        }, { timeout: 60000 });

        // 3. Post-Transaction Notifications (Outside the DB lock for performance)
        if (result) {
            const { payment, invoiceNumber, orderTransitioned, storeOwnerId, totalAmount, offerNumber, orderNumber, customerId, orderId, unitPrice, shippingCost } = result as any;

            await this.offerFulfillment.recomputeOrderStatus(orderId).catch((err) =>
                this.logger.warn(`Fulfillment recompute after payment failed: ${err?.message}`),
            );

            // Notify Merchant
            if (orderTransitioned) {
                this.notifications.create({
                    recipientId: storeOwnerId,
                    recipientRole: 'VENDOR',
                    titleAr: 'طلب جديد جاهز للتجهيز! 📦',
                    titleEn: 'New Order Ready for Preparation! 📦',
                    messageAr: `تم دفع قيمة الطلب #${orderNumber}. يرجى البدء في تجهيز القطع للشحن.`,
                    messageEn: `Payment for Order #${orderNumber} confirmed. Please start preparing parts for shipment.`,
                    type: 'ORDER',
                    link: `/merchant/orders/${orderId}`
                }).catch(() => {});

                this.notifications.notifyAdmins({
                    titleAr: 'تم سداد طلب بنجاح 💸',
                    titleEn: 'Order Payment Successful 💸',
                    messageAr: `تم سداد مبلغ ${totalAmount} درهم للطلب #${orderNumber}.`,
                    messageEn: `Payment of AED ${totalAmount} confirmed for Order #${orderNumber}.`,
                    type: 'PAYMENT',
                    link: `/admin/orders/${orderId}`,
                    metadata: { orderId, amount: totalAmount }
                }).catch(() => {});
            }

            // Final Notification to customer
            this.notifications.create({
                recipientId: customerId,
                recipientRole: 'CUSTOMER',
                type: 'payment',
                titleAr: 'تم الدفع بنجاح! 🎉',
                titleEn: 'Payment Successful! 🎉',
                messageAr: `تم دفع ${totalAmount} درهم بنجاح للعرض #${offerNumber}. نحن الآن نجهز طلبك.`,
                messageEn: `Payment of AED ${totalAmount} successful for offer #${offerNumber}. Preparation started.`,
                link: 'checkout',
                metadata: { orderId, offerId: payment.offerId, amount: totalAmount },
            }).catch(() => {});
        }
    }

    /**
     * Handle payment failures from Stripe.
     * Triggered by payment_intent.payment_failed
     */
    async handlePaymentFailure(paymentIntentId: string) {
        const payment = await this.prisma.paymentTransaction.findFirst({
            where: { stripePaymentId: paymentIntentId },
            include: { order: true }
        });

        if (!payment) return;

        // Idempotency check: don't overwrite success or already failed status
        if (payment.status !== 'PENDING') return;

        await this.prisma.paymentTransaction.update({
            where: { id: payment.id },
            data: { status: 'FAILED' }
        });

        // Notify customer about the failure
        await this.notifications.create({
            recipientId: payment.customerId,
            recipientRole: 'CUSTOMER',
            type: 'payment',
            titleAr: 'عذراً، فشلت عملية الدفع ❌',
            titleEn: 'Payment Failed ❌',
            messageAr: `لم نتمكن من إتمام عملية الدفع للطلب #${payment.order.orderNumber}. يرجى المحاولة مرة أخرى أو استخدام وسيلة دفع مختلفة.`,
            messageEn: `We couldn't process your payment for Order #${payment.order.orderNumber}. Please try again or use a different payment method.`,
            link: `checkout?orderId=${payment.orderId}`,
            metadata: { orderId: payment.orderId, failureReason: 'STRIPE_FAILURE' }
        });
    }

    async handleStripeChargeRefunded(charge: {
        payment_intent?: string | { id?: string } | null;
        amount_refunded?: number;
        amount?: number;
    }) {
        const piRaw = charge.payment_intent;
        const piId = typeof piRaw === 'string' ? piRaw : piRaw?.id;
        if (!piId || charge.amount_refunded == null || charge.amount == null) return;

        const payment = await this.prisma.paymentTransaction.findFirst({
            where: { stripePaymentId: piId },
        });
        if (!payment) {
            this.logger.warn(`Refund webhook: no payment row for PI ${piId}`);
            return;
        }

        const refundedMajor = charge.amount_refunded / 100;
        const fullRefund = charge.amount_refunded >= charge.amount;

        await this.prisma.paymentTransaction.update({
            where: { id: payment.id },
            data: {
                refundedAmount: refundedMajor,
                refundedAt: fullRefund ? new Date() : payment.refundedAt ?? new Date(),
                refundReason: payment.refundReason || 'STRIPE_CHARGE_REFUNDED',
                ...(fullRefund ? { status: 'REFUNDED' } : {}),
            },
        });
    }

    /**
     * Get the current status of a payment for an offer.
     * Used by the frontend to verify status before/after Stripe redirection.
     * (2026 Resilient Sync)
     */
    async getPaymentStatus(customerId: string, offerId: string) {
        const payment = await this.prisma.paymentTransaction.findUnique({
            where: { offerId },
            include: { order: true }
        });

        if (!payment) throw new NotFoundException('Payment record not found');
        if (payment.customerId !== customerId) throw new ForbiddenException('Not owner of this payment');

        return {
            status: payment.status,
            paidAt: payment.paidAt,
            transactionNumber: payment.transactionNumber,
            totalAmount: payment.totalAmount,
            orderId: payment.orderId,
            orderStatus: payment.order.status
        };
    }

    /**
     * Phase 2: Fulfill Shipping Payment (Return/Dispute)
     */
    private async fulfillShippingPayment(intent: any) {
        const { caseId, caseType } = intent.metadata || {};
        if (!caseId || !caseType) {
            this.logger.warn('Shipping fulfillment missing case metadata');
            return;
        }

        const caseBefore =
            caseType === 'return'
                ? await this.prisma.returnRequest.findUnique({ where: { id: caseId } })
                : await this.prisma.dispute.findUnique({ where: { id: caseId } });
        if (!caseBefore) {
            this.logger.warn(`Shipping case record missing for ${caseId}`);
            return;
        }
        if (
            caseBefore.shippingPaymentStatus === 'PAID' &&
            caseBefore.shippingPaymentMethod === 'STRIPE'
        ) {
            this.logger.log(`Shipping payment already fulfilled for ${caseType} ${caseId}; skipping duplicate webhook`);
            return;
        }
        const expectedMinor = Math.round(Number(caseBefore.shippingRefund || 0) * 100);
        if (typeof intent.amount_received === 'number' && intent.amount_received !== expectedMinor) {
            this.logger.error(
                `Shipping PI ${intent.id} amount mismatch: expected ${expectedMinor}, got ${intent.amount_received}`,
            );
            throw new Error('Shipping payment amount mismatch');
        }

        const modelName = caseType === 'return' ? 'returnRequest' : 'dispute';

        this.logger.log(`Fulfilling shipping payment for ${caseType} ${caseId}`);

        return await this.prisma.$transaction(async (tx) => {
            // 1. Update the case status
            const updatedCase = await (tx as any)[modelName].update({
                where: { id: caseId },
                data: {
                    shippingPaymentStatus: 'PAID',
                    shippingPaymentMethod: 'STRIPE',
                    updatedAt: new Date()
                }
            });

            // 2. Create financial log (WalletTransaction for transparency)
            // Even if paid via Stripe, we log it.
            const payeeId = updatedCase.shippingPayee === 'MERCHANT' ? 
                           (await tx.store.findUnique({ where: { id: updatedCase.storeId }, select: { ownerId: true } })).ownerId :
                           updatedCase.customerId;

            let balanceAfter = 0;
            if (updatedCase.shippingPayee === 'MERCHANT') {
                const storeRow = await tx.store.findUnique({
                    where: { id: updatedCase.storeId },
                    select: { balance: true },
                });
                balanceAfter = Number(storeRow?.balance ?? 0);
            } else {
                const userRow = await tx.user.findUnique({
                    where: { id: payeeId },
                    select: { customerBalance: true },
                });
                balanceAfter = Number(userRow?.customerBalance ?? 0);
            }

            await tx.walletTransaction.create({
                data: {
                    userId: payeeId,
                    role: updatedCase.shippingPayee === 'MERCHANT' ? 'VENDOR' : 'CUSTOMER',
                    type: 'DEBIT',
                    transactionType: 'SHIPPING_FEE',
                    amount: Number(updatedCase.shippingRefund),
                    currency: 'AED',
                    description: `Shipping cost for ${caseType} #${updatedCase.orderId} (Paid via Stripe)`,
                    balanceAfter,
                    metadata: { caseId, caseType, paymentMethod: 'STRIPE', stripeIntentId: intent.id },
                }
            });

            // 3. Transition Shipment Status to RETURN_STARTED (بدء الارجاع)
            const shipment = await tx.shipment.findFirst({
                where: { orderId: updatedCase.orderId },
                orderBy: { createdAt: 'desc' }
            });

            if (shipment) {
                await tx.shipment.update({
                    where: { id: shipment.id },
                    data: { status: 'RETURN_STARTED' as any }
                });

                await tx.shipmentStatusLog.create({
                    data: {
                        shipmentId: shipment.id,
                        fromStatus: shipment.status,
                        toStatus: 'RETURN_STARTED' as any,
                        notes: 'بدء الارجاع - تم سداد تكلفة الشحن عبر Stripe',
                        source: 'API'
                    }
                });
            }

            // 4. Notify all parties
            const titleAr = 'تم سداد تكلفة الشحن! 🚚';
            const titleEn = 'Shipping Paid! 🚚';
            const messageAr = `تم استلام دفعة الشحن للطلب #${updatedCase.orderId}. عملية الإرجاع جارية الآن.`;
            const messageEn = `Shipping payment received for Order #${updatedCase.orderId}. Return process is now active.`;

            await this.notifications.create({
                recipientId: updatedCase.customerId,
                recipientRole: 'CUSTOMER',
                type: 'order',
                titleAr, titleEn, messageAr, messageEn,
                link: `orders/${updatedCase.orderId}`,
                metadata: { caseId, caseType }
            });

            const store = await tx.store.findUnique({ where: { id: updatedCase.storeId }, select: { ownerId: true } });
            if (store) {
                await this.notifications.create({
                    recipientId: store.ownerId,
                    recipientRole: 'VENDOR',
                    type: 'order',
                    titleAr, titleEn, messageAr, messageEn,
                    link: `marketplace/orders/${updatedCase.orderId}`,
                    metadata: { caseId, caseType }
                });
            }

            // 5. Notify ADMIN
            const adminTitleAr = `سداد شحن: ${caseType === 'return' ? 'طلب إرجاع' : 'نزاع'} #${updatedCase.orderId}`;
            const adminTitleEn = `Shipping Paid: ${caseType === 'return' ? 'Return' : 'Dispute'} #${updatedCase.orderId}`;
            const adminMsgAr = `قام ${updatedCase.shippingPayee === 'MERCHANT' ? 'التاجر' : 'العميل'} بسداد تكلفة الشحن بقيمة ${updatedCase.shippingRefund} درهم.`;
            const adminMsgEn = `${updatedCase.shippingPayee === 'MERCHANT' ? 'Merchant' : 'Customer'} paid AED ${updatedCase.shippingRefund} for shipping.`;

            // Broadcast to all admins (recipientId = null + role = ADMIN often used for broadcast in our system)
            await this.notifications.create({
                recipientId: null as any,
                recipientRole: 'ADMIN',
                type: 'order',
                titleAr: adminTitleAr,
                titleEn: adminTitleEn,
                messageAr: adminMsgAr,
                messageEn: adminMsgEn,
                link: 'resolution', // Admin resolution center
                metadata: { caseId, caseType }
            });

            return updatedCase;
        });
    }

    /**
     * Detect card brand from card number prefix
     */
    /**
     * Reuse an in-flight Stripe PaymentIntent when the customer retries or when
     * prefetch + pay fire close together. Prevents orphan intents and duplicate DB rows.
     */
    private async resolveOrCreateStripeIntent(
        existingStripePaymentId: string | null | undefined,
        existingStatus: string | null | undefined,
        existingTotalAmount: number,
        totalAmount: number,
        amountCents: number,
        metadata: Record<string, string>,
        stripeCustomerId: string,
    ): Promise<{ id: string; client_secret: string | null }> {
        const reusableStatuses = new Set([
            'requires_payment_method',
            'requires_confirmation',
            'requires_action',
            'processing',
        ]);

        if (
            existingStripePaymentId &&
            existingStatus === 'PENDING' &&
            existingTotalAmount === totalAmount
        ) {
            try {
                const existingIntent = await this.stripeService.retrievePaymentIntent(existingStripePaymentId);
                if (
                    reusableStatuses.has(existingIntent.status) &&
                    existingIntent.amount === amountCents &&
                    existingIntent.client_secret
                ) {
                    this.logger.debug(`Reusing Stripe PaymentIntent ${existingIntent.id}`);
                    return existingIntent;
                }
            } catch (err) {
                this.logger.warn(
                    `Could not reuse PaymentIntent ${existingStripePaymentId}: ${(err as Error).message}`,
                );
            }
        }

        return this.stripeService.createPaymentIntent(
            totalAmount.toString(),
            'AED',
            metadata,
            stripeCustomerId,
        );
    }

    private detectCardBrand(cardNumber: string): string {
        if (cardNumber.startsWith('4')) return 'Visa';
        if (/^5[1-5]/.test(cardNumber) || /^2[2-7]/.test(cardNumber)) return 'Mastercard';
        if (cardNumber.startsWith('34') || cardNumber.startsWith('37')) return 'Amex';
        if (cardNumber.startsWith('62')) return 'UnionPay';
        return 'Unknown';
    }

    /**
     * Get pending (unpaid) accepted offers and their orders for the billing page
     */
    async getPendingPayments(userId: string) {
        // Find orders where customer owns it, and there's at least one ACCEPTED offer
        // that does NOT have a successful payment transaction
        return this.prisma.order.findMany({
            where: {
                customerId: userId,
                offers: {
                    some: {
                        status: 'accepted',
                        payments: {
                            none: {
                                status: 'SUCCESS'
                            }
                        }
                    }
                }
            },
            include: {
                offers: {
                    where: {
                        status: 'accepted',
                        payments: {
                            none: {
                                status: 'SUCCESS'
                            }
                        }
                    },
                    include: {
                        store: true
                    }
                },
                customer: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        phone: true,
                        countryCode: true,
                        country: true,
                    }
                },
                shippingAddresses: true,
                parts: true,
                store: true
            },
            orderBy: { createdAt: 'desc' }
        });
    }

    /**
     * Get pending payments for a merchant (accepted but unpaid offers from their store)
     */
    async getMerchantPendingPayments(userId: string) {
        const store = await this.prisma.store.findUnique({
            where: { ownerId: userId }
        });

        if (!store) return [];

        return this.prisma.order.findMany({
            where: {
                offers: {
                    some: {
                        storeId: store.id,
                        status: 'accepted',
                        payments: {
                            none: {
                                status: 'SUCCESS'
                            }
                        }
                    }
                }
            },
            include: {
                offers: {
                    where: {
                        storeId: store.id,
                        status: 'accepted',
                        payments: {
                            none: {
                                status: 'SUCCESS'
                            }
                        }
                    },
                    include: {
                        store: true
                    }
                },
                customer: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        phone: true,
                        countryCode: true,
                        country: true,
                    }
                },
                shippingAddresses: true,
                parts: true,
                store: true
            },
            orderBy: { createdAt: 'desc' }
        });
    }

    // --- New Wallet APIs ---

    async getCustomerWalletDashboard(userId: string) {
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);

        // Parallel execution of heavy aggregations for 2026 performance standards
        const [
            user, 
            purchaseStats, 
            monthRewardStats, 
            ordersCount, 
            refundedStats, 
            pendingOrders, 
            transactions,
            walletDebitStats,
            lifetimeRewardStats,
        ] = await Promise.all([
            this.prisma.user.findUnique({
                where: { id: userId },
                select: {
                    totalSpent: true,
                    loyaltyPoints: true,
                    loyaltyTier: true,
                    referralCount: true,
                    referralCode: true,
                    customerBalance: true,
                    pointsLastResetAt: true,
                    name: true,
                    withdrawalsFrozen: true,
                    withdrawalFreezeNote: true,
                    orderLimit: true,
                    restrictionAlertMessage: true
                }
            }),
            // 1. Total Purchases (Audit-Grade: Only COMPLETED Orders)
            this.prisma.paymentTransaction.aggregate({
                where: { 
                    customerId: userId, 
                    status: 'SUCCESS',
                    order: { status: 'COMPLETED' }
                },
                _sum: { totalAmount: true }
            }),
            // 2. Monthly Rewards (Profits earned this month)
            this.prisma.walletTransaction.aggregate({
                where: { 
                    userId,
                    role: 'CUSTOMER',
                    type: 'CREDIT',
                    transactionType: { in: ['ORDER_PROFIT', 'REFERRAL_PROFIT'] },
                    createdAt: { gte: startOfMonth } 
                },
                _sum: { amount: true }
            }),
            // 3. Acceptance Rate Basis (Total vs Completed)
            this.prisma.order.aggregate({
                where: { customerId: userId },
                _count: { id: true }
            }),
            // 4. Refunded Amount
            this.prisma.paymentTransaction.aggregate({
                where: { customerId: userId, status: 'REFUNDED' },
                _sum: { refundedAmount: true }
            }),
            // 5. Pending Rewards Basis (Orders paid but not completed)
            this.prisma.order.findMany({
                where: { 
                    customerId: userId, 
                    status: {
                        in: [
                            'PREPARATION',
                            'PREPARED',
                            'VERIFICATION',
                            'VERIFICATION_SUCCESS',
                            'READY_FOR_SHIPPING',
                            'SHIPPED',
                            'DELIVERED',
                            'CORRECTION_PERIOD',
                            'CORRECTION_SUBMITTED',
                            'DELAYED_PREPARATION',
                        ],
                    },
                },
                include: { payments: { where: { status: 'SUCCESS' } } }
            }),
            this.getCustomerTransactions(userId),
            this.prisma.walletTransaction.aggregate({
                where: {
                    userId,
                    role: 'CUSTOMER',
                    type: 'DEBIT',
                    transactionType: { in: ['SHIPPING_FEE', 'PENALTY', 'WITHDRAWAL'] },
                },
                _sum: { amount: true },
            }),
            this.prisma.walletTransaction.aggregate({
                where: {
                    userId,
                    role: 'CUSTOMER',
                    type: 'CREDIT',
                    transactionType: { in: ['ORDER_PROFIT', 'REFERRAL_PROFIT'] },
                },
                _sum: { amount: true },
            }),
        ]);

        if (!user) throw new NotFoundException('User not found');

        // Logic Engineering: Compute Pending Rewards based on REAL SYSTEM COMMISSIONS (25% or 100 AED)
        const tierConfig: any = { BASIC: 0.02, SILVER: 0.03, GOLD: 0.04, VIP: 0.05, PARTNER: 0.06 };
        const userRate = tierConfig[user.loyaltyTier] || 0.02;
        
        const pendingRewards = pendingOrders.reduce((sum, order) => {
            // Aggregate absolute commission taken by the system for this order's successful payments
            const realOrderCommission = order.payments.reduce((cSum, p) => cSum + Number((p as any).commission || 0), 0);
            return sum + (realOrderCommission * userRate);
        }, 0);

        const completedOrders = await this.prisma.order.count({
            where: { customerId: userId, status: 'COMPLETED' }
        });

        const totalOrdersCount = ordersCount._count.id;
        const acceptanceRate = totalOrdersCount > 0 ? (completedOrders / totalOrdersCount) * 100 : 100;

        const purchasesFromPayments = Number(purchaseStats._sum.totalAmount || 0);
        const purchasesFromProfile = Number(user.totalSpent || 0);
        // Align with loyalty tier engine (uses users.total_spent on order COMPLETED)
        const totalPurchases =
            purchasesFromProfile > 0 ? purchasesFromProfile : purchasesFromPayments;

        return {
            stats: {
                ...user,
                customerBalance: Number(user.customerBalance || 0),
                totalSpent: purchasesFromProfile,
                totalPurchases,
                monthlyRewards: Number(monthRewardStats._sum.amount || 0),
                pendingRewards: Number(pendingRewards.toFixed(2)),
                refundedAmount: Number(refundedStats._sum.refundedAmount || 0),
                walletDeductions: Number(walletDebitStats._sum.amount || 0),
                totalRewardsEarned: Number(lifetimeRewardStats._sum.amount || 0),
                completedOrders,
                totalOrdersCount,
                acceptanceRate: Math.round(acceptanceRate),
                profitPercentage: userRate * 100, // Loyalty tier cashback percentage
                referralRate: 0.01, // Fixed 1% referral commission
                referralWindowDays: 180
            },
            transactions
        };
    }

    async getCustomerWallet(userId: string) {
        const dashboard = await this.getCustomerWalletDashboard(userId);
        return dashboard.stats;
    }

    async getCustomerTransactions(userId: string) {
        const [payments, walletTxs] = await Promise.all([
            // 1. Fetch standard payment transactions
            this.prisma.paymentTransaction.findMany({
                where: { customerId: userId, status: { not: 'FAILED' } },
                include: { 
                    order: {
                        select: {
                            id: true,
                            orderNumber: true,
                            status: true
                        }
                    }
                }
            }),
            // 2. Fetch wallet-specific transactions (Loyalty, Referrals, Refunds, Withdrawals)
            this.prisma.walletTransaction.findMany({
                where: { userId, role: 'CUSTOMER' },
                orderBy: { createdAt: 'desc' }
            })
        ]);

        // 3. Normalize and merge for a unified 2026 ledger
        const unifiedLedger = [
            ...payments.map(p => ({
                id: p.id,
                amount: Number(p.totalAmount),
                type: 'DEBIT',
                transactionType: 'PAYMENT',
                status: p.status,
                createdAt: p.createdAt,
                description: `Payment for Order #${p.order?.orderNumber || 'N/A'}`,
                order: p.order,
                metadata: { offerId: p.offerId, transactionNumber: p.transactionNumber }
            })),
            ...walletTxs.map(w => ({
                id: w.id,
                amount: Number(w.amount),
                type: w.type,
                transactionType: w.transactionType,
                status: 'SUCCESS', // Wallet actions are immediate in this system
                createdAt: w.createdAt,
                description: w.description,
                metadata: w.metadata
            }))
        ];

        // 4. Sort by date descending (Real-time Audit Trail)
        return unifiedLedger.sort((a, b) => 
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
    }

    async getMerchantWalletDashboard(userId: string, filters?: { startDate?: string; endDate?: string }) {
        const store = await this.prisma.store.findUnique({
            where: { ownerId: userId },
            include: { owner: true }
        });

        if (!store) throw new NotFoundException('Store not found');

        const dateFilter: any = {};
        if (filters?.startDate) dateFilter.gte = new Date(filters.startDate);
        if (filters?.endDate) {
            const end = new Date(filters.endDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.lte = end;
        }
        const hasDateFilter = Object.keys(dateFilter).length > 0;

        // ═══════════════════════════════════════════════════════
        // 1. Parallel fetch: KPI aggregates (always all-time) + filtered ledger for table
        // ═══════════════════════════════════════════════════════
        const [
            walletActions,
            allTimeVendorTxs,
            gmvAgg,
            merchantShareAgg,
            completedOrderCount,
        ] = await Promise.all([
        this.prisma.walletTransaction.findMany({
            where: { 
                userId: store.ownerId,
                role: 'VENDOR',
                ...(hasDateFilter ? { createdAt: dateFilter } : {})
            },
            include: {
                payment: {
                    include: {
                        order: {
                            select: {
                                id: true,
                                orderNumber: true,
                                status: true
                            }
                        }
                    }
                },
                escrow: {
                    include: {
                        order: {
                            select: {
                                id: true,
                                orderNumber: true,
                                status: true
                            }
                        }
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        }),
        this.prisma.walletTransaction.findMany({
            where: { userId: store.ownerId, role: 'VENDOR' },
            select: {
                amount: true,
                type: true,
                transactionType: true,
                paymentId: true,
                escrowId: true,
            },
        }),
        this.prisma.paymentTransaction.aggregate({
            where: { status: 'SUCCESS', offer: { storeId: store.id } },
            _sum: { totalAmount: true },
        }),
        this.prisma.paymentTransaction.aggregate({
            where: { status: 'SUCCESS', offer: { storeId: store.id } },
            _sum: { unitPrice: true },
        }),
        this.prisma.order.count({
            where: {
                AND: [
                    {
                        OR: [
                            { storeId: store.id },
                            { acceptedOffer: { storeId: store.id } },
                        ],
                    },
                    {
                        OR: [
                            { status: { in: ['COMPLETED', 'DELIVERED'] } },
                            // مدفوع ومحجوز في الضمان (HELD/FROZEN) يُحسب طلباً ناجحاً
                            {
                                escrowTransactions: {
                                    some: { status: { in: ['HELD', 'FROZEN'] } },
                                },
                            },
                        ],
                    },
                ],
            },
        }),
        ]);

        // ═══════════════════════════════════════════════════════
        // 2. Variables & FSM Definitions
        // ═══════════════════════════════════════════════════════
        const stats = {
            available: 0, 
            pending: 0,   
            frozen: 0,    
            totalSales: 0, 
            netEarnings: 0, 
            completedOrders: 0, 
            referralCount: store.owner.referralCount,
            loyaltyPoints: store.owner.loyaltyPoints,
            pendingRewards: 0,
            monthlyRewards: 0,
            earnedReferralProfits: 0 
        };

        const tierConfig: Record<string, { rate: number; benefits: { ar: string; en: string }[] }> = { 
            BASIC: { 
                rate: 0.02, 
                benefits: [
                    { ar: 'شارة بائع موثوق', en: 'Verified Seller Badge' }
                ]
            }, 
            SILVER: { 
                rate: 0.03, 
                benefits: [
                    { ar: 'شارة بائع موثوق', en: 'Verified Seller Badge' },
                    { ar: 'أولوية في نتائج البحث', en: 'Search Result Priority' }
                ]
            }, 
            GOLD: { 
                rate: 0.04, 
                benefits: [
                    { ar: 'شارة بائع موثوق', en: 'Verified Seller Badge' },
                    { ar: 'أولوية في نتائج البحث', en: 'Search Result Priority' },
                    { ar: 'خصم 5% على عمولة المنصة', en: '5% Platform Fee Discount' }
                ]
            }, 
            VIP: { 
                rate: 0.05, 
                benefits: [
                    { ar: 'شارة بائع موثوق', en: 'Verified Seller Badge' },
                    { ar: 'أولوية في نتائج البحث', en: 'Search Result Priority' },
                    { ar: 'خصم 5% على عمولة المنصة', en: '5% Platform Fee Discount' },
                    { ar: 'مدير حساب VIP (24/7)', en: '24/7 VIP Account Manager' }
                ]
            },
            ELITE: {
                rate: 0.05,
                benefits: [
                    { ar: 'أعلى مستوى — دعوة فقط', en: 'Invite-only top tier' },
                    { ar: 'مدير حساب VIP (24/7)', en: '24/7 VIP Account Manager' },
                    { ar: 'أولوية قصوى في الطلبات والظهور', en: 'Maximum order and visibility priority' },
                ],
            },
        };
        
        const currentTierData = tierConfig[store.loyaltyTier] || tierConfig.BASIC;
        const userRate = currentTierData.rate;

        const tiers = ['BASIC', 'SILVER', 'GOLD', 'VIP', 'ELITE'];
        const currentIdx = tiers.indexOf(store.loyaltyTier);
        const nextTier = currentIdx < tiers.length - 1 ? tiers[currentIdx + 1] : null;
        const nextTierData = nextTier ? tierConfig[nextTier] : null;

        const ACTIVE_STATUSES = ['PREPARATION', 'PREPARED', 'VERIFICATION', 'VERIFICATION_SUCCESS', 'READY_FOR_SHIPPING', 'SHIPPED', 'CORRECTION_PERIOD', 'CORRECTION_SUBMITTED', 'DELAYED_PREPARATION', 'NON_MATCHING'];

        const MERCHANT_NET_DEBIT_TYPES = new Set([
            'SHIPPING_FEE',
            'ADJUDICATION_FEE',
            'REFUND',
            'PENALTY',
            'FRAUD_PENALTY',
            'WITHDRAWAL',
        ]);

        // ═══════════════════════════════════════════════════════
        // 3. KPI cards — always all-time (never date-filtered)
        // ═══════════════════════════════════════════════════════
        stats.available = Number(store.balance);
        stats.pending = Number(store.pendingBalance);
        stats.frozen = Number(store.frozenBalance);

        const gmvFromPayments = Number(gmvAgg._sum.totalAmount || 0);
        const merchantShareFromPayments = Number(merchantShareAgg._sum.unitPrice || 0);
        stats.totalSales =
            Number(store.lifetimeEarnings) > 0
                ? Number(store.lifetimeEarnings)
                : gmvFromPayments;

        stats.completedOrders = Math.max(
            Number(store.completedOrdersCount || 0),
            completedOrderCount,
        );

        // Referral profits (all-time)
        for (const action of allTimeVendorTxs) {
            const amount = Number(action.amount);
            const txType = String(action.transactionType || '').toUpperCase();
            if (txType === 'REFERRAL_PROFIT' && action.type === 'CREDIT') {
                stats.earnedReferralProfits += amount;
            }
        }

        // صافي الأرباح = إجمالي أموال التاجر على المنصة (متاح + معلق + مجمد)
        // يطابق الرصيد المستحق + المعلق + المجمد ولا يتأثر بفلتر التاريخ
        const totalFundsOnPlatform = stats.available + stats.pending + stats.frozen;
        stats.netEarnings = Number(totalFundsOnPlatform.toFixed(2));

        // للتقارير: صافي السجل المحاسبي (إيرادات محررة − خصومات)
        let ledgerNet = 0;
        const releasedPaymentIds = new Set<string>();
        for (const action of allTimeVendorTxs) {
            const amount = Number(action.amount);
            const txType = String(action.transactionType || '').toUpperCase();
            if (action.type === 'CREDIT') {
                if (txType === 'REFERRAL_PROFIT') {
                    ledgerNet += amount;
                } else if (
                    action.escrowId &&
                    (['PAYMENT', 'SALE', 'COMMISSION'].includes(txType) || action.paymentId)
                ) {
                    ledgerNet += amount;
                    if (action.paymentId) releasedPaymentIds.add(action.paymentId);
                }
            } else if (action.type === 'DEBIT' && MERCHANT_NET_DEBIT_TYPES.has(txType)) {
                ledgerNet -= amount;
            }
        }
        (stats as any).ledgerNetProfit = Math.max(0, Number(ledgerNet.toFixed(2)));
        (stats as any).merchantShareTotal = merchantShareFromPayments;

        // Backfill store counters when loyalty engine never ran (e.g. test/seed orders)
        if (gmvFromPayments > 0 && Number(store.lifetimeEarnings) === 0) {
            void this.prisma.store
                .update({
                    where: { id: store.id },
                    data: { lifetimeEarnings: gmvFromPayments },
                })
                .catch(() => undefined);
        }
        if (completedOrderCount > Number(store.completedOrdersCount || 0)) {
            void this.prisma.store
                .update({
                    where: { id: store.id },
                    data: { completedOrdersCount: completedOrderCount },
                })
                .catch(() => undefined);
        }

        // ═══════════════════════════════════════════════════════
        // 4. Monthly Context
        // ═══════════════════════════════════════════════════════
        const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        const monthlyAggr = await this.prisma.walletTransaction.aggregate({
            where: {
                userId: store.ownerId,
                role: 'VENDOR',
                type: 'CREDIT',
                transactionType: 'REFERRAL_PROFIT',
                createdAt: { gte: startOfMonth }
            },
            _sum: { amount: true }
        });
        stats.monthlyRewards = Number(monthlyAggr._sum.amount || 0);

        // ═══════════════════════════════════════════════════════
        // 6. True Pending Referral Rewards (v2: 1% of unitPrice + 6-month window)
        //    Active orders from referred users still inside their referral window
        // ═══════════════════════════════════════════════════════
        const REFERRAL_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
        const windowCutoff = new Date(Date.now() - REFERRAL_WINDOW_MS);

        const pendingReferrals = await this.prisma.order.findMany({
            where: {
                status: { in: ACTIVE_STATUSES as any },
                customer: {
                    referredById: store.ownerId,
                    // Window still active: referralStartsAt within last 6 months
                    referralStartsAt: { gte: windowCutoff }
                } as any
            },
            include: { payments: { where: { status: 'SUCCESS' } } }
        });

        let truePendingRewards = 0;
        for (const order of pendingReferrals) {
            const payments = (order as any).payments || [];
            const itemSubtotal = payments.reduce(
                (sum: number, p: any) => sum + Number(p.unitPrice || 0), 0
            );
            if (itemSubtotal > 0) {
                truePendingRewards += itemSubtotal * 0.01; // 1% on item subtotal only
            }
        }
        stats.pendingRewards = Number(truePendingRewards.toFixed(2));

        // ═══════════════════════════════════════════════════════
        // 7. Notifications
        // ═══════════════════════════════════════════════════════
        const notifications = await this.prisma.notification.findMany({
            where: { recipientId: userId, recipientRole: 'MERCHANT' },
            orderBy: { createdAt: 'desc' },
            take: 5
        });

        return {
            stats: {
                ...stats,
                available: Number(stats.available.toFixed(2)),
                pending: Number(stats.pending.toFixed(2)),
                frozen: Number(stats.frozen.toFixed(2)),
                totalSales: Number(stats.totalSales.toFixed(2)),
                netEarnings: Number(stats.netEarnings.toFixed(2)),
                loyaltyTier: store.loyaltyTier,
                performanceScore: Number(store.performanceScore),
                rating: Number(store.rating),
                storeName: store.name || 'Merchant',
                storeId: store.id,
                referralCode: await (async () => {
                    if (store.owner.referralCode) return store.owner.referralCode;
                    let code = '';
                    let isUnique = false;
                    while (!isUnique) {
                        code = Math.random().toString(36).substring(2, 8).toUpperCase();
                        const existing = await this.prisma.user.findUnique({ where: { referralCode: code } });
                        if (!existing) isUnique = true;
                    }
                    await this.prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
                    return code;
                })(),
                profitPercentage: 1, // Fixed 1% referral commission (independent of loyalty tier)
                referralWindowDays: 180,
                tierBenefits: currentTierData.benefits,
                nextTierBenefits: nextTierData?.benefits || [],
                stripeOnboarded: store.owner.stripeOnboarded,
                stripeAccountId: store.owner.stripeAccountId,
                withdrawalsFrozen: store.owner.withdrawalsFrozen,
                withdrawalFreezeNote: store.owner.withdrawalFreezeNote,
                orderLimit: store.owner.orderLimit,
                restrictionAlertMessage: store.owner.restrictionAlertMessage
            },
            notifications,
            transactions: walletActions // Wallet actions has exactly all sales, cancellations, and referrals
        };
    }

    async getMerchantWallet(userId: string) {
        const store = await this.prisma.store.findUnique({
            where: { ownerId: userId },
            select: {
                balance: true,
                pendingBalance: true,
                frozenBalance: true,
                stripeAccountId: true,
                stripeOnboarded: true,
                payoutSchedule: true,
                lifetimeEarnings: true
            }
        });

        if (!store) throw new NotFoundException('Store not found');

        const balance = Number(store.balance);
        const pendingBalance = Number(store.pendingBalance);
        const frozenBalance = Number(store.frozenBalance);
        const totalSales = Number(store.lifetimeEarnings);

        // Logic for "Net Earnings" or "Monthly Sales" could go here
        return {
            ...store,
            balance,
            pendingBalance,
            frozenBalance,
            totalSales
        };
    }

    async getMerchantTransactions(userId: string) {
        const store = await this.prisma.store.findUnique({ where: { ownerId: userId }});
        if(!store) throw new NotFoundException('Store not found');

        return this.prisma.walletTransaction.findMany({
            where: { userId: store.ownerId, role: 'VENDOR' },
            orderBy: { createdAt: 'desc' },
            include: {
                payment: {
                    select: {
                        orderId: true,
                        order: {
                            select: {
                                orderNumber: true,
                                status: true
                            }
                        }
                    }
                }
            }
        });
    }

    async releaseEscrowManually(adminId: string, orderId: string) {
        await this.escrowService.releaseFunds(orderId, 'ADMIN_RELEASE', adminId);
        return { success: true, message: 'Funds released successfully.' };
    }

    // ═══════════════════════════════════════════════════════
    // 7. Withdrawal & Stripe Connect Logic
    // ═══════════════════════════════════════════════════════

    async getStripeOnboardingLink(userId: string) {
        const store = await this.prisma.store.findUnique({
            where: { ownerId: userId },
            include: { owner: true }
        });

        if (!store) throw new NotFoundException('Store not found');

        let stripeAccountId = store.stripeAccountId;
        if (!stripeAccountId) {
            try {
                const account = await this.stripeService.createConnectedAccount(store.id, store.owner.email);
                stripeAccountId = account.id;
            } catch (err: any) {
                this.logger.error(`Stripe Connect account creation failed: ${err.message}`);
                // Handle the specific "not signed up for Connect" error
                if (err.message?.includes('signed up for Connect') || err.type === 'StripeInvalidRequestError') {
                    throw new BadRequestException(
                        'Stripe Connect is not enabled on this platform. Please use Bank Transfer for withdrawals, or contact the admin to enable Stripe Connect.'
                    );
                }
                throw new BadRequestException(`Failed to create Stripe account: ${err.message}`);
            }
        }

        const returnUrl = `http://localhost:5173/dashboard/wallet?stripe_status=return`;
        const refreshUrl = `http://localhost:5173/dashboard/wallet?stripe_status=refresh`;

        return this.stripeService.createOnboardingLink(stripeAccountId, returnUrl, refreshUrl);
    }

    async getCustomerStripeOnboardingLink(userId: string) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId }
        });

        if (!user) throw new NotFoundException('User not found');

        let stripeAccountId = user.stripeAccountId;
        if (!stripeAccountId) {
            try {
                // For customers, we use their email and a generic 'customer' identifier
                const account = await this.stripeService.createConnectedAccount(`cust_${user.id}`, user.email, true);
                stripeAccountId = account.id;
                await this.prisma.user.update({
                    where: { id: userId },
                    data: { stripeAccountId }
                });
            } catch (err: any) {
                this.logger.error(`Customer Stripe Connect account creation failed: ${err.message}`);
                if (err.message?.includes('signed up for Connect')) {
                    throw new BadRequestException('Stripe Connect is not enabled on this platform.');
                }
                throw new BadRequestException(`Failed to create Stripe account: ${err.message}`);
            }
        }

        const returnUrl = `http://localhost:5173/dashboard/wallet?stripe_status=return`;
        const refreshUrl = `http://localhost:5173/dashboard/wallet?stripe_status=refresh`;

        return this.stripeService.createOnboardingLink(stripeAccountId, returnUrl, refreshUrl);
    }

    // ═══════════════════════════════════════════════════════
    // 7b. Bank Details Management
    // ═══════════════════════════════════════════════════════

    async saveBankDetails(userId: string, details: { bankName: string; accountHolder: string; iban: string; swift?: string }) {
        const store = await this.prisma.store.findUnique({ where: { ownerId: userId } });
        if (!store) throw new NotFoundException('Store not found');

        // Basic IBAN validation (length and prefix)
        const iban = details.iban.replace(/\s/g, '').toUpperCase();
        if (iban.length < 15 || iban.length > 34) {
            throw new BadRequestException('Invalid IBAN format');
        }

        await (this.prisma.store.update as any)({
            where: { id: store.id },
            data: {
                bankName: details.bankName,
                bankAccountHolder: details.accountHolder,
                bankIban: iban,
                bankSwift: details.swift || null,
                bankDetailsVerified: false // Admin must verify
            }
        });

        return { success: true, message: 'Bank details saved successfully. Pending admin verification.' };
    }

    async saveCustomerBankDetails(userId: string, details: { bankName: string; accountHolder: string; iban: string; swift?: string }) {
        const iban = details.iban.replace(/\s/g, '').toUpperCase();
        if (iban.length < 15 || iban.length > 34) {
            throw new BadRequestException('Invalid IBAN format');
        }

        await this.prisma.user.update({
            where: { id: userId },
            data: {
                bankName: details.bankName,
                bankAccountHolder: details.accountHolder,
                bankIban: iban,
                bankSwift: details.swift || null,
                bankDetailsVerified: false
            }
        });

        return { success: true, message: 'Bank details saved successfully. Pending admin verification.' };
    }

    async getCustomerBankDetails(userId: string) {
        const user = await this.prisma.user.findUnique({ 
            where: { id: userId },
            select: {
                bankName: true,
                bankAccountHolder: true,
                bankIban: true,
                bankSwift: true,
                bankDetailsVerified: true,
                stripeOnboarded: true,
                stripeAccountId: true
            }
        });
        if (!user) throw new NotFoundException('User not found');

        return {
            bankName: user.bankName,
            accountHolder: user.bankAccountHolder,
            iban: user.bankIban,
            swift: user.bankSwift,
            verified: user.bankDetailsVerified,
            stripeOnboarded: user.stripeOnboarded,
            stripeAccountId: user.stripeAccountId
        };
    }

    async getBankDetails(userId: string) {
        const store = await this.prisma.store.findUnique({ where: { ownerId: userId } });
        if (!store) throw new NotFoundException('Store not found');

        const s = store as any;
        return {
            bankName: s.bankName,
            accountHolder: s.bankAccountHolder,
            iban: s.bankIban,
            swift: s.bankSwift,
            verified: s.bankDetailsVerified,
            stripeOnboarded: store.stripeOnboarded,
            stripeAccountId: store.stripeAccountId
        };
    }

    async adminVerifyBankDetails(adminId: string, targetId: string, role: 'CUSTOMER' | 'VENDOR') {
        if (role === 'CUSTOMER') {
            await this.prisma.user.update({
                where: { id: targetId },
                data: { bankDetailsVerified: true }
            });
        } else {
            await this.prisma.store.update({
                where: { id: targetId },
                data: { bankDetailsVerified: true }
            });
        }

        // Audit log
        // Audit log (2026 Financial Integrity)
        await this.auditLogs.logAction({
            entity: 'FINANCIAL',
            action: 'BANK_DETAILS_VERIFIED',
            actorType: ActorType.ADMIN,
            actorId: adminId,
            metadata: { targetId, role }
        });

        return { success: true, message: 'Bank details verified successfully' };
    }

    async requestWithdrawal(userId: string, amount: number, payoutMethod: string = 'BANK_TRANSFER') {
        const store = await this.prisma.store.findUnique({
            where: { ownerId: userId },
            include: { owner: true }
        });

        if (!store) throw new NotFoundException('Store not found');

        // --- 2026 Governance Enforcement: Withdrawal Freeze ---
        if (store.owner.withdrawalsFrozen) {
            throw new ForbiddenException(store.owner.restrictionAlertMessage || 'Your withdrawals have been frozen by administration.');
        }
        if (store.owner.withdrawalsFrozenUntil && new Date(store.owner.withdrawalsFrozenUntil) > new Date()) {
            throw new ForbiddenException(`Your withdrawals are temporarily frozen until ${new Date(store.owner.withdrawalsFrozenUntil).toLocaleString()}`);
        }
        // ------------------------------------------------------

        // Validate payout method prerequisites
        if (payoutMethod === 'STRIPE' && !store.stripeOnboarded) {
            throw new BadRequestException('Please complete Stripe onboarding first');
        }
        if (payoutMethod === 'BANK_TRANSFER' && !(store as any).bankIban) {
            throw new BadRequestException('Please add your bank details first');
        }

        // Check against global limits
        const limits = await this.getWithdrawalLimits();
        if (amount < limits.min) throw new BadRequestException(`Minimum withdrawal is ${limits.min} AED`);
        if (amount > limits.max) throw new BadRequestException(`Maximum withdrawal is ${limits.max} AED`);

        // Check balance
        if (Number(store.balance) < amount) {
            throw new BadRequestException('Insufficient balance');
        }

        return this.prisma.$transaction(async (tx) => {
            // 1. Create request
            const request = await (tx.withdrawalRequest.create as any)({
                data: {
                    storeId: store.id,
                    amount,
                    payoutMethod,
                    status: 'PENDING'
                }
            });

            // 2. Notify Admins
            const admins = await tx.user.findMany({
                where: { role: { in: ['ADMIN', 'SUPER_ADMIN', 'SUPPORT'] } }
            });

            const methodLabel = payoutMethod === 'STRIPE' ? 'Stripe' : 'Bank Transfer';
            for (const admin of admins) {
                await this.notifications.create({
                    recipientId: admin.id,
                    recipientRole: 'ADMIN',
                    titleAr: 'طلب سحب جديد',
                    titleEn: 'New Withdrawal Request',
                    messageAr: `قام التاجر ${store.name} بطلب سحب ${amount} AED عبر ${payoutMethod === 'STRIPE' ? 'Stripe' : 'تحويل بنكي'}`,
                    messageEn: `Merchant ${store.name} requested a ${methodLabel} withdrawal of ${amount} AED`,
                    type: 'SYSTEM',
                    metadata: { type: 'WITHDRAWAL_REQUEST', requestId: request.id, payoutMethod }
                });
            }

            return request;
        });
    }

    async requestCustomerWithdrawal(userId: string, amount: number, payoutMethod: string = 'BANK_TRANSFER') {
        const user = await this.prisma.user.findUnique({
            where: { id: userId }
        });

        if (!user) throw new NotFoundException('User not found');

        // --- 2026 Governance Enforcement: Withdrawal Freeze ---
        if (user.withdrawalsFrozen) {
            throw new ForbiddenException(user.restrictionAlertMessage || 'Your withdrawals have been frozen by administration.');
        }
        if (user.withdrawalsFrozenUntil && new Date(user.withdrawalsFrozenUntil) > new Date()) {
            throw new ForbiddenException(`Your withdrawals are temporarily frozen until ${new Date(user.withdrawalsFrozenUntil).toLocaleString()}`);
        }
        // ------------------------------------------------------

        // Validate payout method prerequisites
        if (payoutMethod === 'STRIPE' && !user.stripeOnboarded) {
            throw new BadRequestException('Please complete Stripe onboarding first');
        }
        if (payoutMethod === 'BANK_TRANSFER' && !user.bankIban) {
            throw new BadRequestException('Please add your bank details first');
        }

        // Check against global limits
        const limits = await this.getWithdrawalLimits();
        if (amount < limits.min) throw new BadRequestException(`Minimum withdrawal is ${limits.min} AED`);
        if (amount > limits.max) throw new BadRequestException(`Maximum withdrawal is ${limits.max} AED`);

        // Check balance (customerBalance instead of store balance)
        if (Number(user.customerBalance) < amount) {
            throw new BadRequestException('Insufficient balance in your rewards wallet');
        }

        return this.prisma.$transaction(async (tx) => {
            // 1. Create request with role 'CUSTOMER'
            const request = await tx.withdrawalRequest.create({
                data: {
                    userId: user.id,
                    amount,
                    payoutMethod,
                    role: 'CUSTOMER',
                    status: 'PENDING'
                }
            });

            // 2. Notify Admins
            const admins = await tx.user.findMany({
                where: { role: { in: ['ADMIN', 'SUPER_ADMIN', 'SUPPORT'] } }
            });

            const methodLabel = payoutMethod === 'STRIPE' ? 'Stripe' : 'Bank Transfer';
            for (const admin of admins) {
                await this.notifications.create({
                    recipientId: admin.id,
                    recipientRole: 'ADMIN',
                    titleAr: 'طلب سحب عميل جديد',
                    titleEn: 'New Customer Withdrawal Request',
                    messageAr: `قام العميل ${user.name || user.email} بطلب سحب ${amount} AED عبر ${methodLabel}`,
                    messageEn: `Customer ${user.name || user.email} requested a ${methodLabel} withdrawal of ${amount} AED`,
                    type: 'SYSTEM',
                    metadata: { type: 'WITHDRAWAL_REQUEST', requestId: request.id, role: 'CUSTOMER', payoutMethod }
                });
            }

            return request;
        });
    }

    async getWithdrawalRequests(userId: string, role: string) {
        if (role === 'ADMIN' || role === 'SUPER_ADMIN' || role === 'SUPPORT') {
            return this.prisma.withdrawalRequest.findMany({
                include: { 
                    store: { select: { name: true, id: true, balance: true, bankName: true, bankIban: true, bankAccountHolder: true, bankSwift: true, bankDetailsVerified: true } },
                    user: { select: { name: true, email: true, id: true, customerBalance: true, bankName: true, bankIban: true, bankAccountHolder: true, bankSwift: true, bankDetailsVerified: true } }
                },
                orderBy: { createdAt: 'desc' }
            });
        }

        const store = await this.prisma.store.findUnique({ where: { ownerId: userId } });
        
        return this.prisma.withdrawalRequest.findMany({
            where: { 
                OR: [
                    { storeId: store?.id || undefined },
                    { userId: userId }
                ]
            },
            orderBy: { createdAt: 'desc' }
        });
    }

    async processWithdrawalRequest(
        adminId: string, 
        requestId: string, 
        action: 'APPROVE' | 'REJECT', 
        notes?: string,
        adminSignature?: string,
        adminName?: string,
        adminEmail?: string,
        overrideMethod?: string
    ) {
        const request = await this.prisma.withdrawalRequest.findUnique({
            where: { id: requestId },
            include: { store: true }
        });

        if (!request) throw new NotFoundException('Request not found');
        if (request.status !== 'PENDING') throw new BadRequestException('Request already processed');

        if (action === 'REJECT') {
            return this.prisma.withdrawalRequest.update({
                where: { id: requestId },
                data: { status: 'REJECTED', adminNotes: notes }
            });
        }

        // APPROVAL FLOW
        return await this.prisma.$transaction(async (tx) => {
            let balanceAfter = 0;
            let stripeId = null;
            let finalStatus = 'COMPLETED';
            const methodToUse = overrideMethod || request.payoutMethod;

            if (request.role === 'CUSTOMER') {
                // 1. Re-check customer balance
                const user = await tx.user.findUnique({ where: { id: request.userId } });
                if (Number(user.customerBalance) < Number(request.amount)) {
                    throw new BadRequestException('Customer balance is now insufficient');
                }

                // 2. Deduct from customer balance
                await tx.user.update({
                    where: { id: request.userId },
                    data: { customerBalance: { decrement: request.amount } }
                });

                balanceAfter = Number(user.customerBalance) - Number(request.amount);
                stripeId = user.stripeAccountId;
            } else {
                // 1. Re-check store balance
                const store = await tx.store.findUnique({ where: { id: request.storeId } });
                if (Number(store.balance) < Number(request.amount)) {
                    throw new BadRequestException('Store balance is now insufficient');
                }

                // 2. Deduct from store balance
                await tx.store.update({
                    where: { id: request.storeId },
                    data: { balance: { decrement: request.amount } }
                });

                balanceAfter = Number(store.balance) - Number(request.amount);
                stripeId = store.stripeAccountId;
            }

            // 3. Create Debit Wallet Transaction for audit
            await tx.walletTransaction.create({
                data: {
                    userId: request.role === 'CUSTOMER' ? request.userId : request.store.ownerId,
                    role: request.role === 'CUSTOMER' ? 'CUSTOMER' : 'VENDOR',
                    type: 'DEBIT',
                    transactionType: 'withdrawal',
                    amount: request.amount,
                    description: `Withdrawal via ${methodToUse}: ${request.id}`,
                    balanceAfter: balanceAfter,
                    metadata: { requestId: request.id, payoutMethod: methodToUse }
                }
            });

            // 4. Process based on payout method
            let transferId = null;

            if (methodToUse === 'STRIPE') {
                if (!stripeId) throw new BadRequestException('User does not have a Stripe Connect account');
                // Stripe Transfer Flow
                try {
                    const transfer = await this.stripeService.createTransfer(
                        request.amount.toString(),
                        request.currency,
                        stripeId,
                        `WITHDRAWAL_${request.id}`,
                        { requestId: request.id, role: request.role }
                    );
                    transferId = transfer.id;
                } catch (err: any) {
                    this.logger.error(`Stripe Transfer failed for request ${request.id}: ${err.message}`);
                    // Critical Bug Fix: Throw to rollback Prisma transaction instead of setting FAILED
                    throw new BadRequestException(`Stripe Transfer failed: ${err.message}`);
                }
            } else {
                // Bank Transfer Flow
                let bankDetailsValid = false;
                if (request.role === 'CUSTOMER') {
                    const user = await tx.user.findUnique({ where: { id: request.userId } });
                    if (user?.bankIban && user?.bankName) bankDetailsValid = true;
                } else {
                    const store = await tx.store.findUnique({ where: { id: request.storeId } });
                    if (store?.bankIban && store?.bankName) bankDetailsValid = true;
                }

                if (!bankDetailsValid) {
                    throw new BadRequestException('Bank details (IBAN, Bank Name) are missing for this user/store. Cannot process manual bank transfer.');
                }

                // Mark as COMPLETED (admin transfers manually)
                finalStatus = 'COMPLETED';
                this.logger.log(`Bank Transfer approved for request ${request.id} for ${request.role}`);
            }

            await this.auditLogs.logAction({
                entity: 'FINANCIAL',
                action: 'WITHDRAWAL_APPROVAL',
                actorType: ActorType.ADMIN,
                actorId: adminId,
                actorName: adminName,
                metadata: {
                    requestId: request.id,
                    amount: request.amount,
                    method: methodToUse,
                    note: notes,
                    adminEmail,
                    adminSignature: adminSignature || null,
                    stripeTransferId: transferId
                }
            }, tx);

            // 6. Update Request
            const updatedRequest = await tx.withdrawalRequest.update({
                where: { id: requestId },
                data: { 
                    status: finalStatus,
                    payoutMethod: methodToUse, // Reflect the override
                    stripeTransferId: transferId,
                    adminNotes: notes || `Processed via ${methodToUse}`
                }
            });

            // 7. Send Notifications to User/Merchant
            const recipientId = request.role === 'CUSTOMER' ? request.userId : request.store.ownerId;
            const recipientRole = request.role === 'CUSTOMER' ? 'CUSTOMER' : 'VENDOR';

            if (action === 'APPROVE') {
                await this.notifications.create({
                    recipientId: recipientId,
                    recipientRole: recipientRole,
                    type: 'payment',
                    titleAr: methodToUse === 'STRIPE' ? '✅ تم تحويل مبلغ السحب بنجاح' : '✅ تمت الموافقة على طلب السحب',
                    titleEn: methodToUse === 'STRIPE' ? '✅ Withdrawal Transferred Successfully' : '✅ Withdrawal Approved',
                    messageAr: `تمت الموافقة على طلب سحب مبلغ ${request.amount} درهم. سيتم وصول التحويل لحسابك خلال أيام عمل قليلة${adminName ? ' (بواسطة الإدارة: ' + adminName + ')' : ''}. ${notes ? '\\nملاحظة: ' + notes : ''}`,
                    messageEn: `Your withdrawal of AED ${request.amount} has been approved. The transfer will complete in a few business days${adminName ? ' (Processed by: ' + adminName + ')' : ''}. ${notes ? '\\nNote: ' + notes : ''}`,
                    metadata: { type: 'WITHDRAWAL_APPROVED', requestId, method: methodToUse }
                });
            } else if (action === 'REJECT') {
                await this.notifications.create({
                    recipientId: recipientId,
                    recipientRole: recipientRole,
                    type: 'alert',
                    titleAr: '⚠️ تم رفض طلب السحب',
                    titleEn: '⚠️ Withdrawal Request Rejected',
                    messageAr: `تم رفض طلب سحب ${request.amount} درهم لسبب: ${notes || 'غير محدد'}. ${adminName ? 'الإدارة: ' + adminName : ''}. يُرجى مراجعة التفاصيل والمحاولة مرة أخرى.`,
                    messageEn: `Your withdrawal of AED ${request.amount} has been rejected. Reason: ${notes || 'Not specified'}. ${adminName ? 'Admin: ' + adminName : ''}. Please check and try again.`,
                    metadata: { type: 'WITHDRAWAL_REJECTED', requestId, reason: notes }
                });
            }

            return updatedRequest;
        });
    }

    async getWithdrawalLimits() {
        const settings = await this.prisma.platformSettings.findUnique({
            where: { settingKey: 'withdrawal_limits' }
        });

        if (!settings) return { min: 50, max: 10000 };
        return settings.settingValue as any;
    }

    async updateWithdrawalLimits(adminId: string, limits: { min: number, max: number }) {
        const result = await this.prisma.platformSettings.upsert({
            where: { settingKey: 'withdrawal_limits' },
            update: { settingValue: limits },
            create: { settingKey: 'withdrawal_limits', settingValue: limits }
        });

        // Audit Log (2026 Policy Change)
        await this.auditLogs.logAction({
            entity: 'FINANCIAL',
            action: 'UPDATE_WITHDRAWAL_LIMITS',
            actorType: ActorType.ADMIN,
            actorId: adminId,
            metadata: { newLimits: limits }
        });

        return result;
    }

    // --- Admin Financial Hub ---

    async getAdminFinancials(filters?: any) {
        const dateFilter: any = {};
        if (filters?.startDate) dateFilter.gte = new Date(filters.startDate);
        if (filters?.endDate) {
            const end = new Date(filters.endDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.lte = end;
        }
        const hasDateFilter = Object.keys(dateFilter).length > 0;

        const transactionsWhere: Prisma.WalletTransactionWhereInput = {
            ...(hasDateFilter ? { createdAt: dateFilter } : {})
        };

        if (filters?.type && filters.type !== 'ALL') {
            transactionsWhere.type = filters.type;
        }

        if (filters?.role && filters.role !== 'ALL') {
            transactionsWhere.role = filters.role;
        }

        if (filters?.search) {
            const search = filters.search;
            transactionsWhere.OR = [
                { description: { contains: search, mode: 'insensitive' } },
                { user: { name: { contains: search, mode: 'insensitive' } } },
                { transactionType: { contains: search, mode: 'insensitive' } }
            ];
        }

        // Audit-grade aggregates: every filter scoped to SUCCESS payments where relevant
        const successPaymentWhere: Prisma.PaymentTransactionWhereInput = {
            status: 'SUCCESS',
            ...(hasDateFilter ? { createdAt: dateFilter } : {}),
        };

        const [
            totalSalesAgg,
            commissionAgg,
            shippingAgg,
            referralAgg,
            referralCountResult,
            pendingWithdrawalsAgg,
            transactions,
            fullRefundsAgg,
            partialRefundsAgg,
            gatewayFeesAgg,
            loyaltyPointsAgg,
            platformWallet,
            customerBalanceAgg,
            merchantStoreAgg,
            customerRewardsAgg,
            loyaltyPaidAgg,
        ] = await Promise.all([
            // 1. Total Sales (GMV) — only SUCCESS payments
            this.prisma.paymentTransaction.aggregate({
                where: successPaymentWhere,
                _sum: { totalAmount: true },
            }),
            // 2. Platform commission realized on SUCCESS payments
            this.prisma.paymentTransaction.aggregate({
                where: successPaymentWhere,
                _sum: { commission: true },
            }),
            // 3. Shipping revenue collected (paid by customer, transferred to merchant on release)
            this.prisma.paymentTransaction.aggregate({
                where: successPaymentWhere,
                _sum: { shippingCost: true },
            }),
            // 4. Referral profits PAID OUT to referrers (platform expense)
            this.prisma.walletTransaction.aggregate({
                where: {
                    type: 'CREDIT',
                    transactionType: 'REFERRAL_PROFIT',
                    ...(hasDateFilter ? { createdAt: dateFilter } : {}),
                },
                _sum: { amount: true },
            }),
            // 5. Referral count (number of referral payouts in period)
            this.prisma.walletTransaction.count({
                where: {
                    type: 'CREDIT',
                    transactionType: 'REFERRAL_PROFIT',
                    ...(hasDateFilter ? { createdAt: dateFilter } : {}),
                },
            }),
            // 6. Pending Withdrawals (always all-time, not date-filtered — operational queue)
            this.prisma.withdrawalRequest.aggregate({
                where: { status: 'PENDING' },
                _sum: { amount: true },
                _count: { id: true },
            }),
            // 7. Transactions feed
            this.prisma.walletTransaction.findMany({
                where: transactionsWhere,
                include: { user: { select: { name: true, role: true } } },
                orderBy: { createdAt: 'desc' },
                take: filters?.limit ? Number(filters.limit) : 100,
                skip: filters?.page && filters?.limit ? (Number(filters.page) - 1) * Number(filters.limit) : 0,
            }),
            // 8. Full refunds (status REFUNDED)
            this.prisma.paymentTransaction.aggregate({
                where: {
                    status: 'REFUNDED',
                    ...(hasDateFilter ? { createdAt: dateFilter } : {}),
                },
                _sum: { refundedAmount: true },
            }),
            // 9. Partial refunds (status still SUCCESS but refundedAmount > 0)
            this.prisma.paymentTransaction.aggregate({
                where: {
                    status: 'SUCCESS',
                    refundedAmount: { gt: 0 },
                    ...(hasDateFilter ? { createdAt: dateFilter } : {}),
                },
                _sum: { refundedAmount: true },
            }),
            // 10. Gateway fees on SUCCESS payments only (paid by platform to Stripe)
            this.prisma.paymentTransaction.aggregate({
                where: successPaymentWhere,
                _sum: { gatewayFee: true },
            }),
            // 11. Loyalty points outstanding (count, not AED)
            this.prisma.user.aggregate({ _sum: { loyaltyPoints: true } }),
            // 12. Platform wallet (single source of truth for realized revenue)
            this.prisma.platformWallet.findFirst(),
            // 13. Customer balance liabilities (AED owed)
            this.prisma.user.aggregate({ _sum: { customerBalance: true } }),
            // 14. Store balance breakdown (available / escrow held / frozen)
            this.prisma.store.aggregate({
                _sum: { balance: true, pendingBalance: true, frozenBalance: true },
            }),
            // 15. Customer rewards still sitting in wallets (subset of liabilities)
            this.prisma.walletTransaction.aggregate({
                where: {
                    role: 'CUSTOMER',
                    type: 'CREDIT',
                    transactionType: { in: ['ORDER_PROFIT', 'REFERRAL_PROFIT'] },
                },
                _sum: { amount: true },
            }),
            // 16. Loyalty cashback paid to customers (platform expense, ORDER_PROFIT)
            this.prisma.walletTransaction.aggregate({
                where: {
                    role: 'CUSTOMER',
                    type: 'CREDIT',
                    transactionType: 'ORDER_PROFIT',
                    ...(hasDateFilter ? { createdAt: dateFilter } : {}),
                },
                _sum: { amount: true },
            }),
        ]);

        // Build optional date filter for raw SQL (Prisma.sql composition)
        const startDate = filters?.startDate ? new Date(filters.startDate) : null;
        const endDate = filters?.endDate ? new Date(filters.endDate) : null;
        if (endDate) endDate.setHours(23, 59, 59, 999);

        const topSpendersRaw = startDate && endDate
            ? await this.prisma.$queryRaw`
                SELECT "customer_id" as "customerId", SUM("total_amount") as "totalAmount"
                FROM "payment_transactions"
                WHERE "status" = 'SUCCESS' AND "customer_id" IS NOT NULL
                  AND "created_at" BETWEEN ${startDate} AND ${endDate}
                GROUP BY "customer_id"
                ORDER BY "totalAmount" DESC
                LIMIT 5`
            : await this.prisma.$queryRaw`
                SELECT "customer_id" as "customerId", SUM("total_amount") as "totalAmount"
                FROM "payment_transactions"
                WHERE "status" = 'SUCCESS' AND "customer_id" IS NOT NULL
                GROUP BY "customer_id"
                ORDER BY "totalAmount" DESC
                LIMIT 5`;

        const topEarnersRaw = startDate && endDate
            ? await this.prisma.$queryRaw`
                SELECT off."store_id" as "storeId", SUM(pt."unit_price") as "totalAmount"
                FROM "payment_transactions" pt
                JOIN "offers" off ON pt."offer_id" = off."id"
                WHERE pt."status" = 'SUCCESS' AND off."store_id" IS NOT NULL
                  AND pt."created_at" BETWEEN ${startDate} AND ${endDate}
                GROUP BY off."store_id"
                ORDER BY "totalAmount" DESC
                LIMIT 5`
            : await this.prisma.$queryRaw`
                SELECT off."store_id" as "storeId", SUM(pt."unit_price") as "totalAmount"
                FROM "payment_transactions" pt
                JOIN "offers" off ON pt."offer_id" = off."id"
                WHERE pt."status" = 'SUCCESS' AND off."store_id" IS NOT NULL
                GROUP BY off."store_id"
                ORDER BY "totalAmount" DESC
                LIMIT 5`;

        const totalCommission = Number(commissionAgg._sum.commission || 0);
        const totalReferralPaid = Number(referralAgg._sum.amount || 0);
        const totalLoyaltyPaid = Number(loyaltyPaidAgg._sum.amount || 0);
        const totalGatewayFees = Number(gatewayFeesAgg?._sum?.gatewayFee || 0);
        const fullRefunds = Number(fullRefundsAgg._sum.refundedAmount || 0);
        const partialRefunds = Number(partialRefundsAgg._sum.refundedAmount || 0);
        const totalRefunds = fullRefunds + partialRefunds;
        const platformCommissionBal = Number(platformWallet?.commissionBalance || 0);
        const platformFeesBal = Number(platformWallet?.feesBalance || 0);
        const platformTotalRevenue = Number(platformWallet?.totalRevenue || 0);
        const merchantEscrowHeld =
            Number(merchantStoreAgg._sum.pendingBalance || 0) +
            Number(merchantStoreAgg._sum.frozenBalance || 0);
        const userWalletLiabilitiesAed =
            Number(customerBalanceAgg._sum.customerBalance || 0) +
            Number(merchantStoreAgg._sum.balance || 0);

        // Net commission = commission collected − costs paid out by platform
        const netCommission =
            totalCommission - totalReferralPaid - totalLoyaltyPaid - totalGatewayFees;
        const netPlatformPosition = netCommission - totalRefunds;

        // Resolve top spender names & stats
        const spenderIds = (topSpendersRaw as any[]).map((s: any) => s.customerId).filter(Boolean);
        const spenderUsers = await this.prisma.user.findMany({
            where: { id: { in: spenderIds } },
            select: { 
                id: true, 
                name: true, 
                avatar: true,
                _count: { select: { orders: true } }
            }
        });
        const topSpenders = (topSpendersRaw as any[]).map((s: any) => {
            const user = spenderUsers.find(u => u.id === s.customerId);
            return { 
                id: s.customerId, 
                name: user?.name || 'Unknown', 
                avatar: user?.avatar || null, 
                totalSpent: Number(s.totalAmount || 0),
                ordersCount: user?._count?.orders || 0
            };
        });

        // Resolve top earner store names & stats
        const storeIds = (topEarnersRaw as any[]).map((e: any) => e.storeId).filter(Boolean);
        const earnerStores = await this.prisma.store.findMany({
            where: { id: { in: storeIds } },
            select: { 
                id: true, 
                name: true, 
                logo: true, 
                rating: true,
                _count: { select: { orders: true } }
            }
        });
        const topEarners = (topEarnersRaw as any[]).map((e: any) => {
            const store = earnerStores.find(s => s.id === e.storeId);
            return { 
                id: e.storeId, 
                name: store?.name || 'Unknown Store', 
                logo: store?.logo || null,
                rating: store?.rating || 0,
                totalEarned: Number(e.totalAmount || 0),
                ordersCount: store?._count?.orders || 0
            };
        });

        const todayStr = new Date().toDateString();

        return {
            kpis: {
                totalSales: Number(totalSalesAgg._sum.totalAmount || 0),
                grossCommission: totalCommission,
                netCommission,
                netPlatformPosition,
                platformRevenue: platformTotalRevenue,
                platformCommissionBalance: platformCommissionBal,
                platformFeesBalance: platformFeesBal,
                shippingRevenue: Number(shippingAgg._sum.shippingCost || 0),
                shippingProfit: Number(shippingAgg._sum.shippingCost || 0),
                referralEarnings: totalReferralPaid,
                referralPaidOut: totalReferralPaid,
                referralCount: referralCountResult,
                loyaltyCashbackPaid: totalLoyaltyPaid,
                pendingWithdrawals: Number(pendingWithdrawalsAgg._sum.amount || 0),
                pendingWithdrawalsCount: pendingWithdrawalsAgg._count.id,
                frozenFunds: merchantEscrowHeld,
                totalRefunds,
                fullRefunds,
                partialRefunds,
                gatewayFees: totalGatewayFees,
                pendingLiabilities: userWalletLiabilitiesAed,
                loyaltyPointsOutstanding: Number(loyaltyPointsAgg?._sum?.loyaltyPoints || 0),
                customerRewardsInWallets: Number(customerRewardsAgg._sum.amount || 0),
                todayTransactionsCount: transactions.filter(
                    t => new Date(t.createdAt).toDateString() === todayStr,
                ).length,
            },
            transactions: (transactions as any[]).map(t => ({
                id: t.id,
                userId: t.userId,
                userName: t.user?.name || 'Unknown',
                userRole: t.user?.role || t.role,
                amount: Number(t.amount),
                type: t.type,
                transactionType: t.transactionType,
                status: 'COMPLETED',
                date: t.createdAt
            })),
            topSpenders,
            topEarners
        };
    }

    async exportFinancialTransactions(filters?: any) {
        const data = await this.getAdminFinancials(filters);
        return data.transactions;
    }

    async sendManualPayout(adminId: string, dto: AdminManualPayoutDto) {
        const { userId, amount, note, adminName, adminEmail, adminSignature, method } = dto;

        const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { store: true } });
        if (!user) throw new NotFoundException('User not found');

        let balance = 0;
        let role = user.role;
        let stripeId = null;

        if (role === 'CUSTOMER') {
            balance = Number(user.customerBalance || 0);
            stripeId = user.stripeAccountId;
        } else if (user.store) {
            balance = Number(user.store.balance || 0);
            stripeId = user.store.stripeAccountId;
            role = 'VENDOR' as any;
        }

        if (balance < amount) {
            throw new BadRequestException('Insufficient balance for manual payout');
        }

        return this.prisma.$transaction(async (tx) => {
            let balanceAfter = 0;

            if (role === 'CUSTOMER') {
                await tx.user.update({
                    where: { id: userId },
                    data: { customerBalance: { decrement: amount } }
                });
                balanceAfter = balance - amount;
            } else {
                await tx.store.update({
                    where: { id: user.store!.id },
                    data: { balance: { decrement: amount } }
                });
                balanceAfter = balance - amount;
            }

            const walletTx = await tx.walletTransaction.create({
                data: {
                    userId,
                    role: role,
                    type: 'DEBIT',
                    transactionType: 'MANUAL_PAYOUT',
                    amount,
                    description: `Admin Payout: ${note || 'No notes'}`,
                    balanceAfter
                }
            });

            let transferId = null;
            if (method === PayoutMethod.STRIPE_CONNECT) {
                if (!stripeId) throw new BadRequestException('User does not have a Stripe Connect account');
                try {
                    const transfer = await this.stripeService.createTransfer(
                        amount.toString(),
                        'AED',
                        stripeId,
                        `MANUAL_PAYOUT_${walletTx.id}`,
                        { adminId, note }
                    );
                    transferId = transfer.id;
                } catch (err: any) {
                    this.logger.error(`Stripe Transfer failed for manual payout: ${err.message}`);
                    throw new BadRequestException(`Stripe Transfer failed: ${err.message}`);
                }
            }

            await this.auditLogs.logAction({
                entity: 'FINANCIAL',
                action: 'MANUAL_PAYOUT',
                actorType: ActorType.ADMIN,
                actorId: adminId,
                actorName: adminName,
                metadata: {
                    amount,
                    method,
                    note,
                    adminEmail,
                    adminSignature,
                    stripeTransferId: transferId
                }
            }, tx);

            this.notifications.create({
                recipientId: userId,
                titleAr: 'تم إرسال دفعة مالية',
                titleEn: 'Payout Processed',
                messageAr: `تم إرسال دفعة بمبلغ ${amount} درهم إلى حسابك.`,
                messageEn: `A payout of ${amount} AED has been processed to your account.`,
                type: 'financial',
                link: '/dashboard/wallet'
            });

            return {
                success: true,
                message: 'Manual payout executed successfully',
                walletTransactionId: walletTx.id
            };
        });
    }

    /**
     * Phase 1: Unified Financial Feed (2026 Standard)
     * Aggregates events from Payments, Wallet, Escrow, and Withdrawals.
     */
    async getUnifiedFinancialFeed(filters: any) {
        const limit = filters?.limit ? Number(filters.limit) : 50;
        const page = filters?.page ? Number(filters.page) : 1;
        const skip = (page - 1) * limit;

        const dateFilter: any = {};
        if (filters?.startDate) dateFilter.gte = new Date(filters.startDate);
        if (filters?.endDate) {
            const end = new Date(filters.endDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.lte = end;
        }

        const commonWhere: any = Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {};

        // 1. Fetch from 4 sources in parallel
        const [payments, walletTx, escrows, withdrawals] = await Promise.all([
            // Payments Feed
            this.prisma.paymentTransaction.findMany({
                where: { ...commonWhere, ...(filters?.search ? { transactionNumber: { contains: filters.search, mode: 'insensitive' } } : {}) },
                include: { 
                    customer: { select: { id: true, name: true, avatar: true } }, 
                    order: { select: { orderNumber: true } },
                    offer: { include: { store: { select: { id: true, name: true, logo: true, storeCode: true } } } }
                },
                orderBy: { createdAt: 'desc' },
                take: limit + skip
            }),
            // Wallet Feed
            this.prisma.walletTransaction.findMany({
                where: { ...commonWhere, ...(filters?.search ? { description: { contains: filters.search, mode: 'insensitive' } } : {}) },
                include: { 
                    user: { 
                        select: { 
                            id: true, 
                            name: true, 
                            avatar: true,
                            store: { select: { id: true, name: true, logo: true, storeCode: true } }
                        } 
                    }, 
                    payment: { select: { order: { select: { orderNumber: true, id: true } } } } 
                },
                orderBy: { createdAt: 'desc' },
                take: limit + skip
            }),
            // Escrow Feed
            this.prisma.escrowTransaction.findMany({
                where: { ...commonWhere },
                include: { order: { select: { orderNumber: true, customer: { select: { id: true, name: true, avatar: true } }, store: { select: { id: true, name: true, logo: true, storeCode: true } } } } },
                orderBy: { createdAt: 'desc' },
                take: limit + skip
            }),
            // Withdrawals Feed
            this.prisma.withdrawalRequest.findMany({
                where: { ...commonWhere },
                include: { user: { select: { id: true, name: true, avatar: true } }, store: { select: { id: true, name: true, logo: true, storeCode: true } } },
                orderBy: { createdAt: 'desc' },
                take: limit + skip
            })
        ]);

        // 2. Normalize and Map
        const allEvents: UnifiedFinancialEventDto[] = [
            ...payments.map(p => this.mapPaymentToUnified(p)),
            ...walletTx.map(w => this.mapWalletToUnified(w)),
            ...escrows.map(e => this.mapEscrowToUnified(e)),
            ...withdrawals.map(wd => this.mapWithdrawalToUnified(wd))
        ];

        // 3. Global Filter by Type if requested
        let filteredEvents = allEvents;
        if (filters?.type && filters.type !== 'ALL') {
            filteredEvents = allEvents.filter(e => e.source === filters.type || e.eventType === filters.type);
        }

        // 4. Sort and Paginate
        // We use updatedAt if available, falling back to createdAt
        const sorted = filteredEvents.sort((a, b) => {
            const dateA = new Date(a.updatedAt || a.createdAt).getTime();
            const dateB = new Date(b.updatedAt || b.createdAt).getTime();
            return dateB - dateA;
        });

        const paginated = sorted.slice(skip, skip + limit);

        return {
            data: paginated,
            total: sorted.length,
            hasMore: sorted.length > skip + limit
        };
    }

    /**
     * Phase 2: Order Financial Timeline (2026 Audit Trail)
     * Provides a granular history of money flow for a specific order.
     */
    async getOrderFinancialTimeline(orderId: string) {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: {
                customer: { select: { id: true, name: true, avatar: true } },
                offers: {
                    where: { status: 'accepted' },
                    include: { store: { select: { id: true, name: true, logo: true, storeCode: true } } }
                },
                payments: {
                    include: { walletTransactions: true }
                },
                escrowTransactions: {
                    include: { walletTransactions: true }
                },
                auditLogs: {
                    where: { entity: 'FINANCIAL' },
                    orderBy: { timestamp: 'asc' }
                },
                returns: true,
                disputes: true
            }
        });

        if (!order) throw new NotFoundException('Order not found');

        const timeline: any[] = [];

        // 1. Add Payment Events
        order.payments.forEach(pt => {
            timeline.push({
                eventType: 'PAYMENT',
                timestamp: pt.createdAt,
                status: pt.status,
                amount: Number(pt.totalAmount),
                details: {
                    txnNumber: pt.transactionNumber,
                    method: pt.cardBrand,
                    commission: Number(pt.commission),
                    shipping: Number(pt.shippingCost)
                },
                descriptionEn: `Customer paid ${pt.totalAmount} AED for order`,
                descriptionAr: `قام العميل بدفع ${pt.totalAmount} درهم للطلب`
            });

            // Add related wallet transactions (Admin commission etc)
            pt.walletTransactions.forEach(wt => {
                timeline.push({
                    eventType: 'WALLET',
                    timestamp: wt.createdAt,
                    direction: wt.type,
                    amount: Number(wt.amount),
                    role: wt.role,
                    descriptionEn: wt.description || `Wallet ${wt.type} for payment`,
                    descriptionAr: wt.description || `عملية ${wt.type === 'CREDIT' ? 'إيداع' : 'خصم'} للمحفظة`
                });
            });
        });

        // 2. Add Escrow Events (escrowTransactions is an array, use [0] since orderId is unique)
        const escrow = order.escrowTransactions?.[0];
        if (escrow) {
            timeline.push({
                eventType: 'ESCROW',
                timestamp: escrow.createdAt,
                status: escrow.status,
                amount: Number(escrow.merchantAmount),
                descriptionEn: `Funds held in escrow: ${escrow.merchantAmount} AED`,
                descriptionAr: `تم حجز مبلغ ${escrow.merchantAmount} درهم في الضمان`
            });

            if (escrow.status === 'RELEASED') {
                timeline.push({
                    eventType: 'ESCROW_RELEASE',
                    timestamp: escrow.releasedAt,
                    status: 'COMPLETED',
                    amount: Number(escrow.merchantAmount),
                    descriptionEn: `Funds released to merchant: ${escrow.merchantAmount} AED`,
                    descriptionAr: `تم تحرير الأموال للمتجر: ${escrow.merchantAmount} درهم`
                });
            }

            if (escrow.status === 'FROZEN') {
                timeline.push({
                    eventType: 'ESCROW_FREEZE',
                    timestamp: escrow.updatedAt,
                    status: 'FROZEN',
                    amount: Number(escrow.merchantAmount),
                    descriptionEn: `Funds frozen due to dispute: ${escrow.frozenReason || 'Dispute'}`,
                    descriptionAr: `تم تجميد الأموال بسبب نزاع: ${escrow.frozenReason || 'نزاع'}`
                });
            }

            escrow.walletTransactions.forEach(wt => {
                timeline.push({
                    eventType: 'WALLET',
                    timestamp: wt.createdAt,
                    direction: wt.type,
                    amount: Number(wt.amount),
                    role: wt.role,
                    descriptionEn: wt.description || `Wallet ${wt.type} for escrow release`,
                    descriptionAr: wt.description || `عملية ${wt.type === 'CREDIT' ? 'إيداع' : 'خصم'} من الضمان`
                });
            });
        }

        // 3. Add Audit Logs
        order.auditLogs.forEach(log => {
            timeline.push({
                eventType: 'AUDIT',
                timestamp: log.timestamp,
                action: log.action,
                actor: { type: log.actorType, name: log.actorName },
                descriptionEn: `Action: ${log.action} by ${log.actorName || 'System'}`,
                descriptionAr: `إجراء: ${log.action} بواسطة ${log.actorName || 'النظام'}`
            });
        });

        // 4. Add Returns/Disputes
        order.returns.forEach(r => {
            timeline.push({
                eventType: 'RETURN',
                timestamp: r.createdAt,
                status: r.status,
                amount: r.refundAmount ? Number(r.refundAmount) : undefined,
                descriptionEn: `Return requested: ${r.reason}`,
                descriptionAr: `طلب إرجاع: ${r.reason}`
            });
        });

        order.disputes.forEach(d => {
            timeline.push({
                eventType: 'DISPUTE',
                timestamp: d.createdAt,
                status: d.status,
                amount: d.refundAmount ? Number(d.refundAmount) : undefined,
                descriptionEn: `Dispute opened: ${d.reason}`,
                descriptionAr: `تم فتح نزاع: ${d.reason}`
            });
        });

        // Sort by timestamp
        const sortedTimeline = timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        return {
            order: {
                id: order.id,
                orderNumber: order.orderNumber,
                status: order.status,
                createdAt: order.createdAt
            },
            customer: order.customer,
            merchants: order.offers.map(o => o.store),
            timeline: sortedTimeline,
            summary: {
                totalPaid: order.payments.reduce((sum, pt) => sum + Number(pt.totalAmount), 0),
                totalCommission: order.payments.reduce((sum, pt) => sum + Number(pt.commission), 0),
                shippingCosts: order.payments.reduce((sum, pt) => sum + Number(pt.shippingCost), 0),
                merchantEarnings: order.payments.reduce((sum, pt) => {
                    // Merchant gets: Total - Commission - Shipping
                    return sum + (Number(pt.totalAmount) - Number(pt.commission) - Number(pt.shippingCost));
                }, 0),
                escrowStatus: escrow?.status || 'N/A',
                hasDispute: order.disputes.length > 0,
                hasReturn: order.returns.length > 0
            }
        };
    }

    private mapPaymentToUnified(p: any): UnifiedFinancialEventDto {
        return {
            id: p.id,
            source: FinancialEventSource.PAYMENT,
            orderId: p.orderId,
            orderNumber: p.order?.orderNumber,
            customerId: p.customerId,
            customerName: p.customer?.name,
            customerAvatar: p.customer?.avatar,
            storeId: p.offer?.store?.id,
            storeName: p.offer?.store?.name,
            storeLogo: p.offer?.store?.logo,
            storeCode: p.offer?.store?.storeCode,
            amount: Number(p.totalAmount),
            currency: p.currency,
            direction: FinancialDirection.DEBIT,
            eventType: `PAYMENT_${p.status}`,
            eventTypeEn: p.status === 'SUCCESS' ? 'Order Payment Received' : `Payment ${p.status}`,
            eventTypeAr: p.status === 'SUCCESS' ? 'استلام دفعة طلب' : `عملية دفع ${p.status}`,
            status: p.status,
            createdAt: p.createdAt,
            updatedAt: p.paidAt || p.createdAt,
            metadata: { transactionNumber: p.transactionNumber, method: p.cardBrand }
        };
    }

    private mapWalletToUnified(w: any): UnifiedFinancialEventDto {
        const isCredit = w.type === 'CREDIT';
        return {
            id: w.id,
            source: FinancialEventSource.WALLET,
            orderId: w.payment?.order?.id,
            orderNumber: w.payment?.order?.orderNumber,
            customerId: w.role === 'CUSTOMER' ? w.userId : undefined,
            customerName: w.role === 'CUSTOMER' ? w.user?.name : undefined,
            customerAvatar: w.role === 'CUSTOMER' ? w.user?.avatar : undefined,
            storeId: w.role === 'VENDOR' ? w.user?.store?.id : undefined,
            storeName: w.role === 'VENDOR' ? w.user?.store?.name : undefined,
            storeLogo: w.role === 'VENDOR' ? w.user?.store?.logo : undefined,
            storeCode: w.role === 'VENDOR' ? w.user?.store?.storeCode : undefined,
            amount: Number(w.amount),
            currency: w.currency,
            direction: isCredit ? FinancialDirection.CREDIT : FinancialDirection.DEBIT,
            eventType: w.transactionType.toUpperCase(),
            eventTypeEn: this.getWalletTypeLabel(w.transactionType, 'en'),
            eventTypeAr: this.getWalletTypeLabel(w.transactionType, 'ar'),
            status: 'COMPLETED',
            description: w.description,
            createdAt: w.createdAt,
            updatedAt: w.createdAt
        };
    }

    private mapEscrowToUnified(e: any): UnifiedFinancialEventDto {
        return {
            id: e.id,
            source: FinancialEventSource.ESCROW,
            orderId: e.orderId,
            orderNumber: e.order?.orderNumber,
            customerId: e.order?.customer?.id,
            customerName: e.order?.customer?.name,
            storeId: e.order?.store?.id,
            storeName: e.order?.store?.name,
            storeCode: e.order?.store?.storeCode,
            amount: Number(e.merchantAmount),
            currency: 'AED',
            direction: e.status === 'RELEASED' ? FinancialDirection.RELEASE : e.status === 'FROZEN' ? FinancialDirection.FREEZE : FinancialDirection.HOLD,
            eventType: `ESCROW_${e.status}`,
            eventTypeEn: e.status === 'HELD' ? 'Funds Secured in Escrow' : e.status === 'RELEASED' ? 'Escrow Funds Released' : 'Escrow Funds Frozen',
            eventTypeAr: e.status === 'HELD' ? 'تأمين الأموال في الضمان' : e.status === 'RELEASED' ? 'تحرير أموال الضمان' : 'تجميد أموال الضمان',
            status: e.status,
            createdAt: e.createdAt,
            updatedAt: e.releasedAt || e.createdAt
        };
    }

    private mapWithdrawalToUnified(wd: any): UnifiedFinancialEventDto {
        return {
            id: wd.id,
            source: FinancialEventSource.WITHDRAWAL,
            customerId: wd.role === 'CUSTOMER' ? wd.userId : undefined,
            customerName: wd.role === 'CUSTOMER' ? wd.user?.name : undefined,
            customerAvatar: wd.role === 'CUSTOMER' ? wd.user?.avatar : undefined,
            storeId: wd.role === 'VENDOR' ? wd.storeId : undefined,
            storeName: wd.role === 'VENDOR' ? wd.store?.name : undefined,
            storeLogo: wd.role === 'VENDOR' ? wd.store?.logo : undefined,
            storeCode: wd.role === 'VENDOR' ? wd.store?.storeCode : undefined,
            amount: Number(wd.amount),
            currency: wd.currency,
            direction: FinancialDirection.DEBIT,
            eventType: `WITHDRAWAL_${wd.status}`,
            eventTypeEn: this.getWithdrawalLabel(wd.status, 'en'),
            eventTypeAr: this.getWithdrawalLabel(wd.status, 'ar'),
            status: wd.status,
            createdAt: wd.createdAt,
            updatedAt: wd.updatedAt,
            metadata: { method: wd.payoutMethod, role: wd.role }
        };
    }

    private getWalletTypeLabel(type: string, lang: 'ar' | 'en'): string {
        const labels: Record<string, Record<string, string>> = {
            payment: { en: 'Order Payment Received', ar: 'استلام دفعة طلب' },
            commission: { en: 'Platform Commission Earned', ar: 'تحصيل عمولة المنصة' },
            withdrawal: { en: 'Balance Withdrawal', ar: 'سحب رصيد من المحفظة' },
            referral: { en: 'Referral Bonus Reward', ar: 'مكافأة إحالة مستخدم' },
            referral_profit: { en: 'Referral Commission', ar: 'أرباح نظام الإحالة' },
            order_profit: { en: 'Order Profit Released', ar: 'إيداع أرباح الطلب للمتجر' },
            shipping_fee: { en: 'Shipping Logistics Fee', ar: 'رسوم خدمات الشحن' },
            manual_payout: { en: 'Manual Bank Transfer', ar: 'تحويل بنكي يدوي للمتجر' },
            payout: { en: 'Merchant Payout Executed', ar: 'تحويل مستحقات التاجر' },
            refund: { en: 'Customer Refund Processed', ar: 'استرداد مبلغ للعميل' },
            penalty: { en: 'Violation Penalty Deducted', ar: 'خصم غرامة مخالفة' }
        };
        return labels[type.toLowerCase()]?.[lang] || type;
    }

    private getWithdrawalLabel(status: string, lang: 'ar' | 'en'): string {
        const labels: Record<string, Record<string, string>> = {
            pending: { en: 'Withdrawal Request Pending', ar: 'طلب سحب قيد المراجعة' },
            completed: { en: 'Withdrawal Successfully Executed', ar: 'تم تحويل المبلغ بنجاح' },
            approved: { en: 'Withdrawal Approved for Processing', ar: 'تمت الموافقة على السحب' },
            rejected: { en: 'Withdrawal Request Rejected', ar: 'تم رفض طلب السحب' },
            failed: { en: 'Withdrawal Transfer Failed', ar: 'فشل في تحويل المبلغ' }
        };
        return labels[status.toLowerCase()]?.[lang] || `Withdrawal ${status}`;
    }
}
