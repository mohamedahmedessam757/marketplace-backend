import { Injectable, Inject, forwardRef, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoyaltyTier, StoreLoyaltyTier } from '@prisma/client';
import { LoyaltyGateway } from './loyalty.gateway';

@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name);

  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => LoyaltyGateway))
    private readonly loyaltyGateway: LoyaltyGateway
  ) {}

  /**
   * 2026 REWARD ENGINE: Called strictly when an order transitions to COMPLETED.
   * Hardened logic: Rewards are granted only for successful, non-disputed orders.
   */
  async grantOrderCompletionRewards(orderId: string) {
    this.logger.log(`[LoyaltyEngine] Processing 2026 hardened rewards for order ${orderId}`);

    // 1. Fetch Order with Security Audit Data
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: true,
        payments: { where: { status: 'SUCCESS' } },
        disputes: { select: { id: true } },
        returns: { select: { id: true } }
      }
    });

    if (!order || !order.customer) {
      this.logger.error(`[LoyaltyError] Order ${orderId} context missing.`);
      return;
    }

    // 2. EXTREME SECURITY: Verify strict eligibility
    const isEligible = 
        order.status === 'COMPLETED' && 
        order.disputes.length === 0 && 
        order.returns.length === 0;

    if (!isEligible) {
      this.logger.warn(`[LoyaltyWarning] Order ${orderId} ineligible. Status: ${order.status}, Disputes: ${order.disputes.length}, Returns: ${order.returns.length}`);
      return;
    }

    // 3. Compute Financial Basis
    const totalCommission = order.payments.reduce((sum, p) => sum + Number(p.commission || 0), 0);
    const orderTotalAmount = order.payments.reduce((sum, p) => sum + Number(p.totalAmount || 0), 0);

    if (totalCommission <= 0) {
      this.logger.log(`[LoyaltyEngine] Order ${orderId} has no platform commission. Skipping cash rewards.`);
      return;
    }

    // 4. SMART CAPS & TIER CONFIG (v2026 Core Specs)
    const tierConfig: Record<LoyaltyTier, { percent: number; monthlyCap: number }> = {
      BASIC:   { percent: 0.02, monthlyCap: 2000 },
      SILVER:  { percent: 0.03, monthlyCap: 2000 },
      GOLD:    { percent: 0.04, monthlyCap: 2000 },
      VIP:     { percent: 0.05, monthlyCap: 5000 },
      PARTNER: { percent: 0.06, monthlyCap: -1 }, // -1 indicates special dynamic logic (10% of spent)
    };

    const config = tierConfig[order.customer.loyaltyTier] || tierConfig.BASIC;
    
    // 5. Compute Profit with Smart Order-Level Caps
    const EARNED_RAW = totalCommission * config.percent;
    const MIN_ORDER_REWARD = 2.0;
    const MAX_ORDER_REWARD = 150.0;

    let earnedProfit = Math.max(MIN_ORDER_REWARD, Math.min(MAX_ORDER_REWARD, EARNED_RAW));

    // 6. DYNAMIC MONTHLY CAPS (Fiscal Protection)
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    // Calculate actual monthly cap for PARTNER (10% of monthly spent)
    let effectiveMonthlyCap = config.monthlyCap;
    if (order.customer.loyaltyTier === 'PARTNER') {
        const monthlySpentTotal = await this.prisma.order.aggregate({
            where: {
                customerId: order.customerId,
                status: 'COMPLETED',
                createdAt: { gte: startOfMonth }
            },
            _sum: { totalAmount: true }
        });
        effectiveMonthlyCap = Number(monthlySpentTotal._sum.totalAmount || 0) * 0.10;
        // PARTNER has a minimum safety cap of 5000 even if they didn't spend much this month
        if (effectiveMonthlyCap < 5000) effectiveMonthlyCap = 5000;
    }

    // Check current monthly earnings vs cap
    const monthlyProfits = await this.prisma.walletTransaction.aggregate({
      where: {
        userId: order.customerId,
        transactionType: 'ORDER_PROFIT',
        createdAt: { gte: startOfMonth }
      },
      _sum: { amount: true }
    });

    const currentMonthlyProfitTotal = Number(monthlyProfits._sum.amount || 0);
    
    if (currentMonthlyProfitTotal >= effectiveMonthlyCap) {
      this.logger.warn(`[LoyaltyEngine] User ${order.customerId} reached monthly cap (${effectiveMonthlyCap}). Reward skipped.`);
      earnedProfit = 0;

      // Notify user about reaching the cap (v2026 transparency)
      await this.prisma.notification.create({
        data: {
          recipientId: order.customerId,
          titleAr: 'تم الوصول للحد الشهري! 🛑',
          titleEn: 'Monthly Cap Reached! 🛑',
          messageAr: `لقد حققت الحد الأقصى للأرباح لهذا الشهر (${effectiveMonthlyCap} درهم). ستتمكن من البدء في كسب مكافآت جديدة ابتداءً من الشهر القادم. استمر في التميز!`,
          messageEn: `You've reached your maximum profit cap for this month (${effectiveMonthlyCap} AED). You will start earning rewards again next month. Keep it up!`,
          type: 'loyalty',
          link: '/dashboard/wallet'
        }
      });
    } else if (currentMonthlyProfitTotal + earnedProfit > effectiveMonthlyCap) {
      earnedProfit = effectiveMonthlyCap - currentMonthlyProfitTotal;
    }

    // 7. POINTS CALCULATION (1 AED Commission = 1 Reward Point)
    const earnedPoints = Math.floor(totalCommission);

    // 8. ATOMIC EXECUTION (Balance & Progress)
    const currentTotalSpent = Number(order.customer.totalSpent);
    const newTotalSpent = currentTotalSpent + orderTotalAmount;
    const oldTier = order.customer.loyaltyTier;
    const newTier = this.calculateTier(newTotalSpent);

    const result = await this.prisma.$transaction(async (tx) => {
      // a. Synchronize User Stats
      const updatedUser = await tx.user.update({
        where: { id: order.customerId },
        data: {
          totalSpent: newTotalSpent,
          loyaltyTier: newTier,
          loyaltyPoints: { increment: earnedPoints },
          customerBalance: { increment: earnedProfit }
        }
      });

      // b. Immutable Financial Audit Ledger
      if (earnedProfit > 0) {
        await tx.walletTransaction.create({
          data: {
            userId: order.customerId,
            role: 'CUSTOMER',
            type: 'CREDIT',
            transactionType: 'ORDER_PROFIT',
            amount: earnedProfit,
            currency: 'AED',
            description: `Order Success Reward: #${order.orderNumber} (${oldTier} Level)`,
            balanceAfter: Number(updatedUser.customerBalance),
            metadata: { 
                orderId: order.id, 
                commission: totalCommission, 
                rate: `${config.percent * 100}%`,
                capsApplied: earnedProfit < EARNED_RAW
            }
          }
        });
      }

      return updatedUser;
    });

    // 9. REAL-TIME SYNCHRONIZATION
    this.loyaltyGateway.emitLoyaltyUpdate(order.customerId, 'CUSTOMER', {
      tier: newTier,
      loyaltyPoints: result.loyaltyPoints,
      customerBalance: Number(result.customerBalance),
      earnedPoints,
      earnedProfit,
      totalSpent: Number(result.totalSpent)
    });

    // 10. NOTIFICATION ENGINE
    if (this.isTierUpgrade(oldTier, newTier)) {
      await this.prisma.notification.create({
        data: {
          recipientId: order.customerId,
          titleAr: 'ارتقاء مستوى الولاء! 🎊',
          titleEn: 'Loyalty Level Ascended! 🎊',
          messageAr: `مبروك! لقد وصلت إلى مستوى ${newTier}. نسبة أرباحك الآن هي ${tierConfig[newTier].percent * 100}%.`,
          messageEn: `Congrats! You have reached ${newTier} level. Your profit share is now ${tierConfig[newTier].percent * 100}%.`,
          type: 'loyalty',
          link: '/dashboard/wallet'
        }
      });
    }

    return { earnedPoints, earnedProfit, newTier };
  }

  /**
   * Called primarily when an order transitions to CLOSED or COMPLETED
   */
  async processOrderClosure(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: true, payments: true, store: true }
    });

    if (!order) return;

    // 1. Calculate amount spent (from payments sum)
    const totalPayments = order.payments
      .filter(p => p.status === 'SUCCESS')
      .reduce((sum, p) => sum + Number(p.totalAmount || 0), 0);

    if (totalPayments <= 0) return;

    // 2. User Updates: totalSpent & loyaltyPoints (1 point per 10 AED)
    const newTotalSpent = Number(order.customer.totalSpent) + totalPayments;
    const earnedPoints = Math.floor(totalPayments / 10);
    const newTier = this.calculateTier(newTotalSpent);

    const updatedUser = await this.prisma.user.update({
      where: { id: order.customerId },
      data: {
        totalSpent: newTotalSpent,
        loyaltyTier: newTier,
        loyaltyPoints: { increment: earnedPoints }
      }
    });

    // Real-time Update for Customer
    this.loyaltyGateway.emitLoyaltyUpdate(order.customerId, 'CUSTOMER', {
      tier: newTier,
      totalSpent: newTotalSpent,
      loyaltyPoints: updatedUser.loyaltyPoints,
      earnedPoints
    });

    // 3. Merchant Updates: lifetimeEarnings & recalculate tier
    if (order.storeId) {
      const newLifetimeEarnings = Number(order.store.lifetimeEarnings) + totalPayments;
      const newStoreTier = this.calculateStoreTier(newLifetimeEarnings, Number(order.store.rating));
      
      const updatedStore = await this.prisma.store.update({
        where: { id: order.storeId },
        data: {
          lifetimeEarnings: newLifetimeEarnings,
          loyaltyTier: newStoreTier
        }
      });

      // Real-time Update for Merchant
      this.loyaltyGateway.emitLoyaltyUpdate(order.storeId, 'VENDOR', {
        tier: newStoreTier,
        lifetimeEarnings: newLifetimeEarnings,
        performanceScore: Number(updatedStore.performanceScore)
      });

      // Notification for Merchant if tier upgraded
      if (this.isStoreTierUpgrade(order.store.loyaltyTier, newStoreTier)) {
        await this.prisma.notification.create({
          data: {
            recipientId: order.store.ownerId,
            titleAr: 'ترقية مستوى المتجر! 🏆',
            titleEn: 'Store Tier Upgrade! 🏆',
            messageAr: `مبروك! وصلت متجرك إلى مستوى ${newStoreTier}.`,
            messageEn: `Congratulations! Your store reached ${newStoreTier} tier.`,
            type: 'loyalty',
          }
        });
      }
    }

    // 4. Referral Reward (If first successful order)
    await this.processReferralReward(order.customerId, totalPayments);

    // 5. Fire Push Notification (If user tier increased)
    if (this.isTierUpgrade(order.customer.loyaltyTier, newTier)) {
      await this.prisma.notification.create({
        data: {
          recipientId: order.customerId,
          titleAr: 'ترقية المستوى! 🎉',
          titleEn: 'Tier Upgrade! 🎉',
          messageAr: `مبروك! لقد وصلت إلى المستوى ${newTier}. استمتع بمميزات أكثر.`,
          messageEn: `Congratulations! You have reached ${newTier} tier. Enjoy more benefits.`,
          type: 'loyalty',
        }
      });
    }

    return { newTotalSpent, newTier, earnedPoints };
  }

  async processReferralReward(userId: string, orderAmount: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { 
        id: true, 
        name: true,
        referredById: true, 
        orders: { where: { status: 'COMPLETED' } } 
      }
    });

    // Strategy: Reward only on first COMPLETED order and if referred
    if (user && user.referredById && user.orders.length === 1) {
      const rewardAmount = Number((orderAmount * 0.05).toFixed(2)); // 5% cash reward
      
      const result = await this.prisma.$transaction(async (tx) => {
        // a. Update Referrer Stats & Balance
        const referrer = await tx.user.update({
          where: { id: user.referredById },
          data: {
            customerBalance: { increment: rewardAmount },
            loyaltyPoints: { increment: Math.floor(rewardAmount) },
            referralCount: { increment: 1 }
          }
        });

        // b. Financial Audit Trail
        await tx.walletTransaction.create({
          data: {
            userId: user.referredById,
            role: 'CUSTOMER',
            type: 'CREDIT',
            transactionType: 'REFERRAL_PROFIT',
            amount: rewardAmount,
            currency: 'AED',
            description: `Success Referral Reward: Friend ${user.name || 'User'} joined and shopped!`,
            balanceAfter: Number(referrer.customerBalance),
            metadata: { referredUserId: userId, orderAmount }
          }
        });

        return referrer;
      });

      // c. Real-time Reflection
      this.loyaltyGateway.emitLoyaltyUpdate(user.referredById, 'CUSTOMER', {
        customerBalance: Number(result.customerBalance),
        loyaltyPoints: result.loyaltyPoints,
        referralCount: result.referralCount
      });

      // d. Premium Encouraging Notification
      await this.prisma.notification.create({
        data: {
          recipientId: user.referredById,
          titleAr: 'مكافأة نجاح مبهرة! 🌟💸',
          titleEn: 'Spectacular Referral Reward! 🌟💸',
          messageAr: `خبر رائع! صديقك ${user.name || ''} أكمل طلبه الأول. تقديراً لتوصيتك، أضفنا ${rewardAmount} درهم إلى محفظتك. استمر في مشاركة التميز! 🚀`,
          messageEn: `Great news! Your friend ${user.name || ''} completed their first order. As a token of thanks, we've added ${rewardAmount} AED to your wallet. Keep sharing the excellence! 🚀`,
          type: 'loyalty',
          link: '/dashboard/wallet'
        }
      });
    }
  }

  async getLoyaltyData(userId: string) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          loyaltyTier: true,
          totalSpent: true,
          loyaltyPoints: true,
          referralCount: true,
          referralCode: true,
          customerBalance: true,
        }
      });

      if (!user) {
        return {
          loyaltyTier: 'BASIC',
          totalSpent: 0,
          loyaltyPoints: 0,
          referralCount: 0,
          referralCode: null,
          submittedReviews: []
        };
      }

      // Safe separate fetch for reviews to prevent schema mismatch from crashing the whole page
      let submittedReviews = [];
      try {
        const reviews = await this.prisma.review.findMany({
            where: { customerId: userId },
            include: { store: true },
            orderBy: { createdAt: 'desc' }
        });
        submittedReviews = reviews;
      } catch (reviewError) {
        this.logger.warn(`Failed to fetch reviews for user ${userId} (Schema mismatch likely): ${reviewError.message}`);
      }

      return {
          ...user,
          submittedReviews
      };
    } catch (error) {
      this.logger.error(`Error fetching loyalty data for user ${userId}`, error);
      // Fallback empty state for DB schema mismatch/migration issues
      return {
          loyaltyTier: 'BASIC',
          totalSpent: 0,
          loyaltyPoints: 0,
          referralCount: 0,
          referralCode: null,
          submittedReviews: []
      };
    }
  }

  async getMerchantLoyalty(storeId: string) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: {
        loyaltyTier: true,
        performanceScore: true,
        lifetimeEarnings: true,
        rating: true,
        reviews: {
          take: 5,
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    return store;
  }

  calculateTier(totalSpent: number): LoyaltyTier {
    if (totalSpent >= 20000) return 'PARTNER';
    if (totalSpent >= 10000) return 'VIP';
    if (totalSpent >= 3000) return 'GOLD';
    if (totalSpent >= 1000) return 'SILVER';
    return 'BASIC';
  }

  calculateStoreTier(lifetimeEarnings: number, rating: number): StoreLoyaltyTier {
    // 2026 Standards: High rating is required for top tiers
    if (lifetimeEarnings >= 200000 && rating >= 4.8) return 'PLATINUM';
    if (lifetimeEarnings >= 50000 && rating >= 4.5) return 'GOLD';
    if (lifetimeEarnings >= 10000 && rating >= 4.0) return 'SILVER';
    return 'BRONZE';
  }

  isTierUpgrade(oldTier: LoyaltyTier, newTier: LoyaltyTier): boolean {
    const ranks: Record<string, number> = { 'BASIC': 1, 'SILVER': 2, 'GOLD': 3, 'VIP': 4, 'PARTNER': 5 };
    return ranks[newTier] > ranks[oldTier];
  }

  isStoreTierUpgrade(oldTier: StoreLoyaltyTier, newTier: StoreLoyaltyTier): boolean {
    const ranks: Record<string, number> = { 'BRONZE': 1, 'SILVER': 2, 'GOLD': 3, 'PLATINUM': 4 };
    return ranks[newTier] > ranks[oldTier];
  }
}
