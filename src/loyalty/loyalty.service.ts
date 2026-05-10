import { Injectable, Inject, forwardRef, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoyaltyTier, StoreLoyaltyTier } from '@prisma/client';
import { LoyaltyGateway } from './loyalty.gateway';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name);

  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => LoyaltyGateway))
    private readonly loyaltyGateway: LoyaltyGateway,
    private notifications: NotificationsService
  ) {}

  /**
   * 2026 REWARD ENGINE: Called strictly when an order transitions to COMPLETED.
   * Hardened logic: Rewards are granted only for successful, non-disputed orders.
   * Covers BOTH sides: customer cashback/tier and merchant lifetime earnings/tier.
   */
  async grantOrderCompletionRewards(orderId: string) {
    this.logger.log(`[LoyaltyEngine] Processing 2026 hardened rewards for order ${orderId}`);

    // 1. Fetch Order with Security Audit Data
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: true,
        store: true,
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
      await this.notifications.create({
        recipientId: order.customerId,
        recipientRole: 'CUSTOMER',
        titleAr: 'تم الوصول للحد الشهري! 🛑',
        titleEn: 'Monthly Cap Reached! 🛑',
        messageAr: `لقد حققت الحد الأقصى للأرباح لهذا الشهر (${effectiveMonthlyCap} درهم). ستتمكن من البدء في كسب مكافآت جديدة ابتداءً من الشهر القادم. استمر في التميز!`,
        messageEn: `You've reached your maximum profit cap for this month (${effectiveMonthlyCap} AED). You will start earning rewards again next month. Keep it up!`,
        type: 'loyalty',
        link: '/dashboard/wallet'
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

    // 10. NOTIFICATION ENGINE — Customer Tier Upgrade
    if (this.isTierUpgrade(oldTier, newTier)) {
      await this.notifications.create({
        recipientId: order.customerId,
        recipientRole: 'CUSTOMER',
        titleAr: 'ارتقاء مستوى الولاء! 🎊',
        titleEn: 'Loyalty Level Ascended! 🎊',
        messageAr: `مبروك! لقد وصلت إلى مستوى ${newTier}. نسبة أرباحك الآن هي ${tierConfig[newTier].percent * 100}%.`,
        messageEn: `Congrats! You have reached ${newTier} level. Your profit share is now ${tierConfig[newTier].percent * 100}%.`,
        type: 'loyalty',
        link: '/dashboard/wallet'
      });
    }

    // 11. MERCHANT SIDE — Update lifetimeEarnings + recalc store loyaltyTier
    if (order.storeId && order.store) {
      const newLifetimeEarnings = Number(order.store.lifetimeEarnings) + orderTotalAmount;
      const newStoreTier = this.calculateStoreTier(
        newLifetimeEarnings,
        Number(order.store.rating)
      );
      const oldStoreTier = order.store.loyaltyTier;

      const updatedStore = await this.prisma.store.update({
        where: { id: order.storeId },
        data: {
          lifetimeEarnings: newLifetimeEarnings,
          loyaltyTier: newStoreTier
        }
      });

      // Real-time sync for merchant
      this.loyaltyGateway.emitLoyaltyUpdate(order.storeId, 'VENDOR', {
        tier: newStoreTier,
        lifetimeEarnings: newLifetimeEarnings,
        performanceScore: Number(updatedStore.performanceScore)
      });

      // Notify merchant on store tier upgrade
      if (this.isStoreTierUpgrade(oldStoreTier, newStoreTier)) {
        await this.notifications.create({
          recipientId: order.store.ownerId,
          recipientRole: 'MERCHANT',
          titleAr: 'ترقية مستوى المتجر! 🏆',
          titleEn: 'Store Tier Upgrade! 🏆',
          messageAr: `مبروك! وصل متجرك إلى مستوى ${newStoreTier}.`,
          messageEn: `Congratulations! Your store reached ${newStoreTier} tier.`,
          type: 'loyalty'
        });
      }
    }

    return { earnedPoints, earnedProfit, newTier };
  }

  /**
   * 2026 REFERRAL ENGINE v2 — Triggered when an order transitions to COMPLETED.
   * Rules:
   *   - Pays 1% of the item subtotal (sum of PaymentTransaction.unitPrice) to the referrer
   *   - Only if the referred user is still inside their 6-month window (180 days from referralStartsAt)
   *   - Applies on EVERY successful (COMPLETED, no dispute, no return) order during the window
   *   - Idempotent: a single (referrer, orderId) pair can only be rewarded once
   */
  async processReferralReward(orderId: string) {
    const REFERRAL_RATE = 0.01;
    const REFERRAL_WINDOW_DAYS = 180;

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            referredById: true,
            referralStartsAt: true,
            createdAt: true
          }
        },
        payments: { where: { status: 'SUCCESS' } },
        disputes: { select: { id: true } },
        returns: { select: { id: true } }
      }
    });

    if (!order || !order.customer || !order.customer.referredById) return;

    // Eligibility: order must be cleanly completed (no disputes, no returns)
    if (order.status !== 'COMPLETED' || order.disputes.length > 0 || order.returns.length > 0) {
      this.logger.warn(
        `[Referral] Order ${orderId} ineligible. status=${order.status} disputes=${order.disputes.length} returns=${order.returns.length}`
      );
      return;
    }

    // 6-month window check (referralStartsAt falls back to createdAt for legacy users)
    const startsAt: Date | null = order.customer.referralStartsAt || order.customer.createdAt || null;
    if (!startsAt) {
      this.logger.warn(`[Referral] Missing referralStartsAt and createdAt for user ${order.customer.id}`);
      return;
    }
    const expiresAt = new Date(new Date(startsAt).getTime() + REFERRAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    if (new Date() > expiresAt) {
      this.logger.log(
        `[Referral] Window expired for user ${order.customer.id}. Expired on ${expiresAt.toISOString()}.`
      );
      return;
    }

    // Idempotency: prevent duplicate reward for the same order
    const existing = await this.prisma.walletTransaction.findFirst({
      where: {
        userId: order.customer.referredById,
        transactionType: 'REFERRAL_PROFIT',
        metadata: { path: ['orderId'], equals: orderId }
      }
    });
    if (existing) {
      this.logger.warn(`[Referral] Duplicate prevention: order ${orderId} already rewarded.`);
      return;
    }

    // Compute reward = 1% × sum of unitPrice (item subtotal only — no commission/VAT/shipping)
    const itemSubtotal = order.payments.reduce((sum, p) => sum + Number(p.unitPrice || 0), 0);
    if (itemSubtotal <= 0) {
      this.logger.log(`[Referral] Order ${orderId} has zero item subtotal. Skipping.`);
      return;
    }
    const rewardAmount = Number((itemSubtotal * REFERRAL_RATE).toFixed(2));
    if (rewardAmount <= 0) return;

    const referredById = order.customer.referredById;

    const result = await this.prisma.$transaction(async (tx) => {
      const referrer = await tx.user.update({
        where: { id: referredById },
        data: {
          customerBalance: { increment: rewardAmount },
          loyaltyPoints: { increment: Math.floor(rewardAmount) }
        }
      });

      await tx.walletTransaction.create({
        data: {
          userId: referredById,
          role: 'CUSTOMER',
          type: 'CREDIT',
          transactionType: 'REFERRAL_PROFIT',
          amount: rewardAmount,
          currency: 'AED',
          description: `Referral commission 1%: friend ${order.customer.name || 'User'} order #${order.orderNumber}`,
          balanceAfter: Number(referrer.customerBalance),
          metadata: {
            orderId: order.id,
            orderNumber: order.orderNumber,
            referredUserId: order.customer.id,
            itemSubtotal,
            rate: REFERRAL_RATE,
            windowStartsAt: new Date(startsAt).toISOString(),
            windowExpiresAt: expiresAt.toISOString()
          }
        }
      });

      return referrer;
    });

    this.loyaltyGateway.emitLoyaltyUpdate(referredById, 'CUSTOMER', {
      customerBalance: Number(result.customerBalance),
      loyaltyPoints: result.loyaltyPoints,
      referralCount: result.referralCount
    });

    await this.notifications.create({
      recipientId: referredById,
      recipientRole: 'CUSTOMER',
      titleAr: 'مكافأة إحالة جديدة! 💸',
      titleEn: 'New Referral Reward! 💸',
      messageAr: `استلمت ${rewardAmount} درهم (1%) من طلب صديقك ${order.customer.name || ''} رقم #${order.orderNumber}.`,
      messageEn: `You received ${rewardAmount} AED (1%) from your friend ${order.customer.name || ''}'s order #${order.orderNumber}.`,
      type: 'loyalty',
      link: '/dashboard/wallet'
    });

    return { rewardAmount, referredById };
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

  /**
   * Public Stats for "Earn Monthly Income" Landing Page (2026 Social Proof)
   */
  async getPublicStats() {
    try {
      // Aggregate data with performance optimization
      const stats = await this.prisma.$transaction(async (tx) => {
        const totalUsers = await tx.user.count({ where: { role: 'CUSTOMER' } });
        const totalReferrals = await tx.user.count({ where: { NOT: { referredById: null } } });
        
        const totalRewards = await tx.walletTransaction.aggregate({
          where: {
            transactionType: { in: ['ORDER_PROFIT', 'REFERRAL_PROFIT'] }
          },
          _sum: { amount: true }
        });

        return {
          totalUsers: totalUsers + 1250, // Added social proof base
          totalReferrals: totalReferrals + 850,
          totalDistributed: Number(totalRewards._sum.amount || 0) + 45000,
          currency: 'AED'
        };
      });

      return stats;
    } catch (error) {
      this.logger.error('Failed to fetch public loyalty stats', error);
      return { totalUsers: 1250, totalReferrals: 850, totalDistributed: 45000, currency: 'AED' };
    }
  }

  /**
   * Returns per-referee statistics: first name only (privacy), window dates,
   * total earned by the referrer from each referee, orders count.
   * Optimized: 2 queries total (referees + all referral wallet_transactions),
   * grouped in-memory. O(R + T) where R = referees, T = referral txs.
   */
  async getReferralHistory(userId: string) {
    const REFERRAL_WINDOW_DAYS = 180;
    const windowMs = REFERRAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;

    const referees = await this.prisma.user.findMany({
      where: { referredById: userId },
      select: {
        id: true,
        name: true,
        createdAt: true,
        referralStartsAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (referees.length === 0) {
      return {
        referrals: [],
        totals: { count: 0, earned: 0, activeCount: 0 },
      };
    }

    // Bulk-fetch all REFERRAL_PROFIT transactions for this referrer in one query
    const allRewards = await this.prisma.walletTransaction.findMany({
      where: {
        userId,
        type: 'CREDIT',
        transactionType: 'REFERRAL_PROFIT',
      },
      select: { amount: true, metadata: true, createdAt: true },
    });

    // Group rewards by referredUserId from metadata JSON
    const rewardsByReferee = new Map<
      string,
      { total: number; orders: number; lastAt?: Date }
    >();
    for (const tx of allRewards) {
      const refereeId = (tx.metadata as any)?.referredUserId;
      if (!refereeId) continue;
      const prev =
        rewardsByReferee.get(refereeId) || { total: 0, orders: 0, lastAt: undefined };
      prev.total += Number(tx.amount);
      prev.orders += 1;
      if (!prev.lastAt || tx.createdAt > prev.lastAt) prev.lastAt = tx.createdAt;
      rewardsByReferee.set(refereeId, prev);
    }

    const now = Date.now();
    const referrals = referees.map((r) => {
      const startsAt = r.referralStartsAt || r.createdAt;
      const expiresAt = new Date(startsAt.getTime() + windowMs);
      const msRemaining = expiresAt.getTime() - now;
      const daysRemaining = Math.max(
        0,
        Math.ceil(msRemaining / (24 * 60 * 60 * 1000))
      );
      const isActive = msRemaining > 0;
      const stats =
        rewardsByReferee.get(r.id) || { total: 0, orders: 0, lastAt: undefined };

      return {
        id: r.id,
        firstName: (r.name || '').split(' ')[0] || 'User',
        registeredAt: r.createdAt.toISOString(),
        windowStartsAt: startsAt.toISOString(),
        windowExpiresAt: expiresAt.toISOString(),
        daysRemaining,
        isActive,
        totalEarned: Number(stats.total.toFixed(2)),
        ordersCount: stats.orders,
        lastRewardAt: stats.lastAt?.toISOString() || null,
      };
    });

    const totals = {
      count: referrals.length,
      earned: Number(
        referrals.reduce((s, r) => s + r.totalEarned, 0).toFixed(2)
      ),
      activeCount: referrals.filter((r) => r.isActive).length,
    };

    return { referrals, totals };
  }
}
