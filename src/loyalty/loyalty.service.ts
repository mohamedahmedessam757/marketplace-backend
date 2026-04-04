import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoyaltyTier, StoreLoyaltyTier } from '@prisma/client';
import { LoyaltyGateway } from './loyalty.gateway';

@Injectable()
export class LoyaltyService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => LoyaltyGateway))
    private readonly loyaltyGateway: LoyaltyGateway
  ) {}

  /**
   * Called primarily when an order transitions to CLOSED
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
      select: { id: true, referredById: true, orders: { where: { status: 'CLOSED' } } }
    });

    // Reward only on first CLOSED order and if referred
    if (user && user.referredById && user.orders.length === 1) {
      const rewardAmount = orderAmount * 0.05; // 5% cashback to referrer
      
      // Update Referrer
      await this.prisma.user.update({
        where: { id: user.referredById },
        data: {
          loyaltyPoints: { increment: Math.floor(rewardAmount) },
          referralCount: { increment: 1 }
        }
      });

      // Notify Referrer
      await this.prisma.notification.create({
        data: {
          recipientId: user.referredById,
          titleAr: 'مكافأة إحالة! 💸',
          titleEn: 'Referral Reward! 💸',
          messageAr: 'لقد حصلت على مكافأة لأن صديقك أكمل طلبه الأول!',
          messageEn: 'You earned a reward because your friend completed their first order!',
          type: 'loyalty',
          metadata: { referredUserId: userId, amount: rewardAmount }
        }
      });
    }
  }

  async getLoyaltyData(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        loyaltyTier: true,
        totalSpent: true,
        loyaltyPoints: true,
        referralCount: true,
        referralCode: true,
        submittedReviews: {
          include: { store: true },
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    return user;
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
