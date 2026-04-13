import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StripeService } from '../stripe/stripe.service';
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
        private readonly stripeService: StripeService,
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
        // 1. Fetch wallet transactions (The Single Source of Truth)
        // ═══════════════════════════════════════════════════════
        const walletActions = await this.prisma.walletTransaction.findMany({
            where: { 
                userId: store.ownerId,
                role: 'VENDOR',
                ...(hasDateFilter ? { createdAt: dateFilter } : {})
            },
            include: {
                payment: {
                    select: {
                        orderId: true,
                        status: true,
                        totalAmount: true,
                        unitPrice: true,
                        commission: true,
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
        });

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
            BRONZE: { 
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
            PLATINUM: { 
                rate: 0.05, 
                benefits: [
                    { ar: 'شارة بائع موثوق', en: 'Verified Seller Badge' },
                    { ar: 'أولوية في نتائج البحث', en: 'Search Result Priority' },
                    { ar: 'خصم 5% على عمولة المنصة', en: '5% Platform Fee Discount' },
                    { ar: 'مدير حساب VIP (24/7)', en: '24/7 VIP Account Manager' }
                ]
            } 
        };
        
        const currentTierData = tierConfig[store.loyaltyTier] || tierConfig.BRONZE;
        const userRate = currentTierData.rate;

        const tiers = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'];
        const currentIdx = tiers.indexOf(store.loyaltyTier);
        const nextTier = currentIdx < tiers.length - 1 ? tiers[currentIdx + 1] : null;
        const nextTierData = nextTier ? tierConfig[nextTier] : null;

        const COMPLETED_STATUSES = ['COMPLETED', 'DELIVERED'];
        const ACTIVE_STATUSES = ['PREPARATION', 'PREPARED', 'VERIFICATION', 'VERIFICATION_SUCCESS', 'READY_FOR_SHIPPING', 'SHIPPED', 'CORRECTION_PERIOD', 'CORRECTION_SUBMITTED', 'DELAYED_PREPARATION', 'NON_MATCHING'];
        const FROZEN_STATUSES = ['DISPUTED', 'RETURN_REQUESTED', 'RETURNED', 'RETURN_APPROVED'];
        const EXCLUDED_STATUSES = ['CANCELLED', 'AWAITING_PAYMENT', 'AWAITING_OFFERS', 'REFUNDED'];

        const processedOrderIds = new Set<string>();

        // ═══════════════════════════════════════════════════════
        // 3. Process Financials with extreme precision
        // ═══════════════════════════════════════════════════════
        walletActions.forEach(action => {
            const amount = Number(action.amount);

            // A) Referral Profits Earned
            if (action.transactionType === 'REFERRAL_PROFIT' && action.type === 'CREDIT') {
                stats.available += amount;
                stats.netEarnings += amount;
                stats.earnedReferralProfits += amount;
            } 
            // B) Withdrawals
            else if (action.transactionType === 'WITHDRAWAL' && action.type === 'DEBIT') {
                stats.available -= amount;
            } 
            // C) Sales & Platform Income Flows
            else if (['payment', 'SALE', 'commission'].includes(action.transactionType) && action.type === 'CREDIT') {
                const orderStatus = action.payment?.order?.status || 'COMPLETED'; // fallback to completed if standalone

                if (COMPLETED_STATUSES.includes(orderStatus)) {
                    stats.available += amount;
                    stats.netEarnings += amount;
                    
                    if (action.payment?.order?.id && !processedOrderIds.has(action.payment.order.id)) {
                        stats.completedOrders += 1;
                        processedOrderIds.add(action.payment.order.id);
                    }
                }
                else if (ACTIVE_STATUSES.includes(orderStatus)) {
                    stats.pending += amount;
                }
                else if (FROZEN_STATUSES.includes(orderStatus)) {
                    stats.frozen += amount;
                }

                if (!EXCLUDED_STATUSES.includes(orderStatus)) {
                    stats.totalSales += amount;
                }
            }
            // D) Refunds Debited
            else if (action.transactionType === 'refund' && action.type === 'DEBIT') {
                stats.totalSales -= amount; // Deduct from sales since it was cancelled
            }
        });

        // ═══════════════════════════════════════════════════════
        // 4. Monthly Context
        // ═══════════════════════════════════════════════════════
        const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        const monthlyAggr = await this.prisma.walletTransaction.aggregate({
            where: {
                userId: store.ownerId,
                type: 'CREDIT',
                transactionType: 'REFERRAL_PROFIT',
                createdAt: { gte: startOfMonth }
            },
            _sum: { amount: true }
        });
        stats.monthlyRewards = Number(monthlyAggr._sum.amount || 0);

        // ═══════════════════════════════════════════════════════
        // 6. True Pending Referral Rewards
        //    (5% of active first-time orders from referred users)
        // ═══════════════════════════════════════════════════════
        const pendingReferrals = await this.prisma.order.findMany({
            where: {
                status: { in: ACTIVE_STATUSES as any },
                customer: { 
                    referredById: store.ownerId,
                    // Must be their first order (no completed ones yet)
                    orders: {
                        none: { status: { in: COMPLETED_STATUSES as any } }
                    }
                }
            },
            include: { payments: { where: { status: 'SUCCESS' } } }
        });

        let truePendingRewards = 0;
        for (const order of pendingReferrals) {
            const payments = (order as any).payments || [];
            const orderTotal = payments.reduce((sum: number, p: any) => sum + Number(p.totalAmount || 0), 0);
            if (orderTotal > 0) {
                truePendingRewards += (orderTotal * 0.05); // 5% referral reward rate
            } else if (order.totalAmount) {
                truePendingRewards += (Number(order.totalAmount) * 0.05);
            }
        }
        stats.pendingRewards = truePendingRewards;

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
                profitPercentage: userRate * 100,
                tierBenefits: currentTierData.benefits,
                nextTierBenefits: nextTierData?.benefits || []
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

    async releaseEscrowManually(orderId: string) {
        await this.escrowService.releaseFunds(orderId, 'ADMIN_RELEASE');
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

    async requestWithdrawal(userId: string, amount: number, payoutMethod: string = 'BANK_TRANSFER') {
        const store = await this.prisma.store.findUnique({
            where: { ownerId: userId }
        });

        if (!store) throw new NotFoundException('Store not found');

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
                where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } }
            });

            const methodLabel = payoutMethod === 'STRIPE' ? 'Stripe' : 'Bank Transfer';
            for (const admin of admins) {
                await this.notifications.create({
                    recipientId: admin.id,
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
                where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } }
            });

            const methodLabel = payoutMethod === 'STRIPE' ? 'Stripe' : 'Bank Transfer';
            for (const admin of admins) {
                await this.notifications.create({
                    recipientId: admin.id,
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
        if (role === 'ADMIN' || role === 'SUPER_ADMIN') {
            return this.prisma.withdrawalRequest.findMany({
                include: { 
                    store: { select: { name: true, id: true } },
                    user: { select: { name: true, email: true, id: true } }
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

    async processWithdrawalRequest(adminId: string, requestId: string, action: 'APPROVE' | 'REJECT', notes?: string) {
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
        return this.prisma.$transaction(async (tx) => {
            let balanceAfter = 0;
            let stripeId = null;
            let finalStatus = 'COMPLETED';

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
                    description: `Withdrawal via ${request.payoutMethod}: ${request.id}`,
                    balanceAfter: balanceAfter,
                    metadata: { requestId: request.id, payoutMethod: request.payoutMethod }
                }
            });

            // 4. Process based on payout method
            let transferId = null;

            if (request.payoutMethod === 'STRIPE') {
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
                    finalStatus = 'FAILED';
                }
            } else {
                // Bank Transfer Flow - Mark as COMPLETED (admin transfers manually)
                finalStatus = 'COMPLETED';
                this.logger.log(`Bank Transfer approved for request ${request.id} for ${request.role}`);
            }

            // 5. Update Request
            return tx.withdrawalRequest.update({
                where: { id: requestId },
                data: { 
                    status: finalStatus,
                    stripeTransferId: transferId,
                    adminNotes: notes || (finalStatus === 'COMPLETED' ? `Processed via ${request.payoutMethod}` : 'Stripe transfer failed')
                }
            });
        });
    }

    async getWithdrawalLimits() {
        const settings = await this.prisma.platformSettings.findUnique({
            where: { settingKey: 'withdrawal_limits' }
        });

        if (!settings) return { min: 50, max: 10000 };
        return settings.settingValue as any;
    }

    async updateWithdrawalLimits(limits: { min: number, max: number }) {
        return this.prisma.platformSettings.upsert({
            where: { settingKey: 'withdrawal_limits' },
            update: { settingValue: limits },
            create: { settingKey: 'withdrawal_limits', settingValue: limits }
        });
    }
}

