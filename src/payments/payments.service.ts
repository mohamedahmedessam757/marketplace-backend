import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ProcessPaymentDto } from './dto/process-payment.dto';
import { Prisma } from '@prisma/client';

import { EscrowService } from './escrow.service';

@Injectable()
export class PaymentsService {
    private readonly logger = new Logger(PaymentsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly notifications: NotificationsService,
        private readonly escrowService: EscrowService,
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
        if (order.status !== 'AWAITING_PAYMENT') {
            throw new BadRequestException('Order is not in AWAITING_PAYMENT status');
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
                let orderTransitioned = false;

                if (allPaid) {
                    // Transition order to PREPARATION
                    await tx.order.update({
                        where: { id: orderId },
                        data: { status: 'PREPARATION' },
                    });

                    // Audit log
                    await tx.auditLog.create({
                        data: {
                            orderId,
                            action: 'STATUS_CHANGE',
                            entity: 'Order',
                            actorType: 'CUSTOMER',
                            actorId: customerId,
                            previousState: 'AWAITING_PAYMENT',
                            newState: 'PREPARATION',
                            reason: 'All offers paid successfully',
                        },
                    });

                    orderTransitioned = true;
                }

                return {
                    payment,
                    invoiceNumber,
                    transactionNumber,
                    allPaid,
                    orderTransitioned,
                    remainingOffers: allAcceptedOfferIds.length - paidCount,
                };
            });
        } catch (error) {
            // Handle Prisma unique constraint violation (race condition safety net)
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                this.logger.warn(`Duplicate payment attempt for offer ${offerId} caught by DB constraint`);
                throw new ConflictException('This offer has already been paid (duplicate detected)');
            }
            throw error; // Re-throw any other errors
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
     * Detect card brand from card number prefix
     */
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
            transactions
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
                    name: true
                }
            }),
            // 1. Total Purchases (All Successful Payments)
            this.prisma.paymentTransaction.aggregate({
                where: { customerId: userId, status: 'SUCCESS' },
                _sum: { totalAmount: true }
            }),
            // 2. Monthly Rewards (Profits earned this month)
            this.prisma.walletTransaction.aggregate({
                where: { 
                    userId: userId, 
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
                    status: { in: ['PREPARATION', 'SHIPPED', 'DELIVERED', 'READY_FOR_SHIPPING'] } 
                },
                include: { payments: { where: { status: 'SUCCESS' } } }
            }),
            this.getCustomerTransactions(userId)
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

        return {
            stats: {
                ...user,
                totalSpent: Number(user.totalSpent || 0),
                totalPurchases: Number(purchaseStats._sum.totalAmount || 0),
                monthlyRewards: Number(monthRewardStats._sum.amount || 0),
                pendingRewards: Number(pendingRewards.toFixed(2)),
                refundedAmount: Number(refundedStats._sum.refundedAmount || 0),
                completedOrders,
                totalOrdersCount,
                acceptanceRate: Math.round(acceptanceRate),
                profitPercentage: userRate * 100
            },
            transactions
        };
    }

    async getCustomerWallet(userId: string) {
        const dashboard = await this.getCustomerWalletDashboard(userId);
        return dashboard.stats;
    }

    async getCustomerTransactions(userId: string) {
        const payments = await this.prisma.paymentTransaction.findMany({
            where: { customerId: userId, status: { not: 'FAILED' } },
            orderBy: { createdAt: 'desc' },
            include: { 
                order: {
                    select: {
                        id: true,
                        orderNumber: true,
                        status: true
                    }
                }
            }
        });

        // Ensure backward compatibility with the UI and statement report
        // by injecting the exact fields the frontend expects exclusively for payments.
        return payments.map(p => ({
            ...p,
            amount: Number(p.totalAmount),
            type: 'DEBIT',
            transactionType: 'PAYMENT'
        }));
    }

    async getMerchantWalletDashboard(userId: string) {
        const store = await this.prisma.store.findUnique({
            where: { ownerId: userId },
            include: { owner: true }
        });

        if (!store) throw new NotFoundException('Store not found');

        const [transactions, notifications, pendingOrders] = await Promise.all([
            this.getMerchantTransactions(userId),
            this.prisma.notification.findMany({
                where: { recipientId: userId, recipientRole: 'MERCHANT' },
                orderBy: { createdAt: 'desc' },
                take: 5
            }),
            this.prisma.order.findMany({
                where: { 
                    storeId: store.id,
                    status: { in: ['PREPARATION', 'SHIPPED', 'DELIVERED', 'READY_FOR_SHIPPING'] } 
                },
                include: { payments: { where: { status: 'SUCCESS' } } }
            })
        ]);

        // Logic Engineering: Compute Loyalty Profits from Referrals (Same as Customer)
        const tierConfig: any = { BRONZE: 0.02, SILVER: 0.03, GOLD: 0.04, PLATINUM: 0.05, PARTNER: 0.06 };
        const userRate = tierConfig[store.loyaltyTier] || 0.02;
        
        const pendingRewards = pendingOrders.reduce((sum, order) => {
            const realOrderCommission = order.payments.reduce((cSum, p) => cSum + Number((p as any).commission || 0), 0);
            return sum + (realOrderCommission * userRate);
        }, 0);

        const monthlyRewards = await this.prisma.walletTransaction.aggregate({
            where: { 
                userId: userId, 
                type: 'CREDIT',
                transactionType: 'REFERRAL_PROFIT',
                createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } 
            },
            _sum: { amount: true }
        });

        const completedOrdersCount = await this.prisma.order.count({
            where: { storeId: store.id, status: 'COMPLETED' }
        });

        return {
            stats: {
                available: Number(store.balance),
                pending: Number(store.pendingBalance),
                frozen: Number(store.frozenBalance),
                totalSales: Number(store.lifetimeEarnings),
                netEarnings: Number(store.balance) + Number(store.pendingBalance),
                completedOrders: completedOrdersCount,
                loyaltyTier: store.loyaltyTier,
                performanceScore: Number(store.performanceScore),
                rating: Number(store.rating),
                storeName: store.name || 'Merchant',
                referralCode: await (async () => {
                    if (store.owner.referralCode) return store.owner.referralCode;
                    // Self-healing: Generate missing referral code
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
                referralCount: store.owner.referralCount,
                loyaltyPoints: store.owner.loyaltyPoints,
                pendingRewards: Number(pendingRewards.toFixed(2)),
                monthlyRewards: Number(monthlyRewards._sum.amount || 0),
                profitPercentage: userRate * 100
            },
            transactions,
            notifications
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

    async releaseEscrowManually(orderId: string) {
        await this.escrowService.releaseFunds(orderId, 'ADMIN_RELEASE');
        return { success: true, message: 'Funds released successfully.' };
    }
}
