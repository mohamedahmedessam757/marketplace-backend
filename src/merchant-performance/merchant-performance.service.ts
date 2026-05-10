import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import {
  Prisma,
  StoreLoyaltyTier,
  StoreSubscriptionTier,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LoyaltyGateway } from '../loyalty/loyalty.gateway';
import { NotificationsService } from '../notifications/notifications.service';

const TIER_ORDER: Record<StoreLoyaltyTier, number> = {
  BASIC: 1,
  SILVER: 2,
  GOLD: 3,
  VIP: 4,
  ELITE: 5,
};

const GOLD_MIN_COMPLETED_ORDERS = 10;
const GOLD_MIN_ACCOUNT_AGE_DAYS = 30;
const VIP_MIN_COMPLETED_ORDERS = 50;

export type MerchantPerformanceBenefit = { ar: string; en: string };

@Injectable()
export class MerchantPerformanceService {
  private readonly logger = new Logger(MerchantPerformanceService.name);

  /** Wallet / commission alignment — keep in sync with payments.service tierConfig rates where needed */
  readonly tierBenefits: Record<
    StoreLoyaltyTier,
    { rate: number; benefits: MerchantPerformanceBenefit[] }
  > = {
    BASIC: {
      rate: 0.02,
      benefits: [
        { ar: 'ظهور عادي وعدد عروض محدود', en: 'Standard visibility, limited offers' },
      ],
    },
    SILVER: {
      rate: 0.03,
      benefits: [
        { ar: 'ظهور أفضل وزيادة في عدد العروض', en: 'Better visibility and more offers' },
      ],
    },
    GOLD: {
      rate: 0.04,
      benefits: [
        { ar: 'أولوية الظهور وشارة موثوق', en: 'Search priority and trusted badge' },
        { ar: 'خصم على عمولة المنصة', en: 'Platform fee discount' },
      ],
    },
    VIP: {
      rate: 0.05,
      benefits: [
        { ar: 'أعلى أولوية ظهور', en: 'Highest search priority' },
        { ar: 'شارة خاصة وأولوية في الطلبات', en: 'Special badge and order priority' },
        { ar: 'مدير حساب مميز', en: 'Dedicated account manager' },
      ],
    },
    ELITE: {
      rate: 0.05,
      benefits: [
        { ar: 'أعلى مستوى — دعوة فقط', en: 'Top tier — invite only' },
        { ar: 'مزايا VIP بالإضافة إلى دعم مخصص', en: 'All VIP benefits plus bespoke support' },
      ],
    },
  };

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => LoyaltyGateway))
    private readonly loyaltyGateway: LoyaltyGateway,
    private readonly notifications: NotificationsService,
  ) {}

  tierRank(tier: StoreLoyaltyTier): number {
    return TIER_ORDER[tier] ?? 1;
  }

  /** 40% level + 40% rating + 20% response (0–5 scale). Response falls back to store rating if unset. */
  computeRankingScore(
    tier: StoreLoyaltyTier,
    rating: number,
    avgResponseScore: number,
  ): number {
    const maxAuto = 4; // BASIC..VIP for normalization; ELITE uses 5
    const rank = this.tierRank(tier);
    const normLevel = rank >= 5 ? 1 : (rank - 1) / (maxAuto - 1);
    const normRating = Math.min(1, Math.max(0, rating / 5));
    const response = avgResponseScore > 0 ? avgResponseScore : rating;
    const normResponse = Math.min(1, Math.max(0, response / 5));
    const raw =
      0.4 * normLevel + 0.4 * normRating + 0.2 * normResponse;
    return Math.round(raw * 10000) / 100;
  }

  subscriptionEffective(
    active: boolean,
    tier: StoreSubscriptionTier,
    expiresAt: Date | null,
  ): boolean {
    if (!active || tier === StoreSubscriptionTier.NONE) return false;
    if (expiresAt && expiresAt.getTime() < Date.now()) return false;
    return true;
  }

  computeAutoTier(input: {
    rating: number;
    violationPoints: number;
    subscriptionTier: StoreSubscriptionTier;
    subscriptionActive: boolean;
    subscriptionExpiresAt: Date | null;
    completedOrders: number;
    storeCreatedAt: Date;
  }): StoreLoyaltyTier {
    const subOk = this.subscriptionEffective(
      input.subscriptionActive,
      input.subscriptionTier,
      input.subscriptionExpiresAt,
    );
    if (!subOk) return StoreLoyaltyTier.BASIC;

    const r = input.rating;
    const v = input.violationPoints;
    const o = input.completedOrders;
    const ageMs = Date.now() - input.storeCreatedAt.getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1000);

    const isStdOrPrem =
      input.subscriptionTier === StoreSubscriptionTier.STANDARD ||
      input.subscriptionTier === StoreSubscriptionTier.PREMIUM;

    if (
      r >= 4.5 &&
      v < 10 &&
      input.subscriptionTier === StoreSubscriptionTier.PREMIUM &&
      o >= VIP_MIN_COMPLETED_ORDERS
    ) {
      return StoreLoyaltyTier.VIP;
    }
    if (
      r >= 4.0 &&
      v < 25 &&
      isStdOrPrem &&
      o >= GOLD_MIN_COMPLETED_ORDERS &&
      ageDays >= GOLD_MIN_ACCOUNT_AGE_DAYS
    ) {
      return StoreLoyaltyTier.GOLD;
    }
    if (r >= 3.5 && v < 40 && isStdOrPrem) {
      return StoreLoyaltyTier.SILVER;
    }
    return StoreLoyaltyTier.BASIC;
  }

  isTierUpgrade(oldTier: StoreLoyaltyTier, newTier: StoreLoyaltyTier): boolean {
    return this.tierRank(newTier) > this.tierRank(oldTier);
  }

  isTierDowngrade(oldTier: StoreLoyaltyTier, newTier: StoreLoyaltyTier): boolean {
    return this.tierRank(newTier) < this.tierRank(oldTier);
  }

  /**
   * Single source of truth: persist loyaltyTier + performanceScore, notify, realtime.
   */
  async recalculateAndPersist(
    storeId: string,
    opts?: { skipNotifications?: boolean; skipRealtime?: boolean },
  ): Promise<{
    store: { id: string; loyaltyTier: StoreLoyaltyTier; performanceScore: Prisma.Decimal };
    previousTier: StoreLoyaltyTier;
    nextTier: StoreLoyaltyTier;
  } | null> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      include: {
        owner: { select: { id: true, violationScore: true } },
      },
    });
    if (!store || !store.owner) {
      this.logger.warn(`recalculateAndPersist: store ${storeId} not found or missing owner`);
      return null;
    }

    const preserveElite = store.loyaltyTier === StoreLoyaltyTier.ELITE;
    const autoTier = this.computeAutoTier({
      rating: Number(store.rating),
      violationPoints: store.owner.violationScore,
      subscriptionTier: store.subscriptionTier,
      subscriptionActive: store.subscriptionActive,
      subscriptionExpiresAt: store.subscriptionExpiresAt,
      completedOrders: store.completedOrdersCount,
      storeCreatedAt: store.createdAt,
    });

    const nextTier = preserveElite ? StoreLoyaltyTier.ELITE : autoTier;
    const rankingScore = this.computeRankingScore(
      nextTier,
      Number(store.rating),
      Number(store.avgResponseScore),
    );
    const previousTier = store.loyaltyTier;

    const updated = await this.prisma.store.update({
      where: { id: storeId },
      data: {
        loyaltyTier: nextTier,
        performanceScore: rankingScore,
      },
      select: { id: true, loyaltyTier: true, performanceScore: true },
    });

    if (!opts?.skipRealtime) {
      const fresh = await this.prisma.store.findUnique({
        where: { id: storeId },
        select: { lifetimeEarnings: true },
      });
      this.loyaltyGateway.emitLoyaltyUpdate(storeId, 'VENDOR', {
        tier: nextTier,
        performanceScore: rankingScore,
        violationPoints: store.owner.violationScore,
        subscriptionActive: this.subscriptionEffective(
          store.subscriptionActive,
          store.subscriptionTier,
          store.subscriptionExpiresAt,
        ),
        completedOrdersCount: store.completedOrdersCount,
        rating: Number(store.rating),
        lifetimeEarnings: fresh ? Number(fresh.lifetimeEarnings) : undefined,
      });
    }

    if (!opts?.skipNotifications && !preserveElite) {
      if (this.isTierUpgrade(previousTier, nextTier)) {
        await this.notifications.create({
          recipientId: store.ownerId,
          recipientRole: 'MERCHANT',
          titleAr: 'ترقية مستوى الأداء! 🏆',
          titleEn: 'Performance tier upgraded! 🏆',
          messageAr: `وصل متجرك إلى مستوى ${nextTier}.`,
          messageEn: `Your store reached performance tier ${nextTier}.`,
          type: 'loyalty',
        });
      } else if (this.isTierDowngrade(previousTier, nextTier)) {
        await this.notifications.create({
          recipientId: store.ownerId,
          recipientRole: 'MERCHANT',
          titleAr: 'تغيير في مستوى الأداء',
          titleEn: 'Performance tier adjusted',
          messageAr: `تم تعديل مستوى متجرك إلى ${nextTier}. راجع التقييم والمخالفات والاشتراك.`,
          messageEn: `Your store tier was adjusted to ${nextTier}. Review rating, violations, and subscription.`,
          type: 'alert',
        });
      }
    }

    return { store: updated, previousTier, nextTier };
  }

  /** Full payload for merchant dashboard + Gemini UI */
  async getDashboardForOwner(ownerId: string) {
    const store = await this.prisma.store.findUnique({
      where: { ownerId },
      include: {
        owner: { select: { id: true, violationScore: true, referralCode: true } },
      },
    });
    if (!store) return null;

    const subEffective = this.subscriptionEffective(
      store.subscriptionActive,
      store.subscriptionTier,
      store.subscriptionExpiresAt,
    );

    const autoTier = this.computeAutoTier({
      rating: Number(store.rating),
      violationPoints: store.owner.violationScore,
      subscriptionTier: store.subscriptionTier,
      subscriptionActive: store.subscriptionActive,
      subscriptionExpiresAt: store.subscriptionExpiresAt,
      completedOrders: store.completedOrdersCount,
      storeCreatedAt: store.createdAt,
    });

    const nextTierUp = this.nextTier(store.loyaltyTier);
    const progress = this.buildProgressSnapshot({
      currentTier: store.loyaltyTier,
      nextTier: nextTierUp,
      rating: Number(store.rating),
      violationPoints: store.owner.violationScore,
      completedOrders: store.completedOrdersCount,
      storeCreatedAt: store.createdAt,
      subscriptionTier: store.subscriptionTier,
      subscriptionEffective: subEffective,
    });

    const tierRow = this.tierBenefits[store.loyaltyTier];
    const benefitsTable = (
      ['BASIC', 'SILVER', 'GOLD', 'VIP', 'ELITE'] as StoreLoyaltyTier[]
    ).map((tier) => ({
      tier,
      benefits: this.tierBenefits[tier].benefits,
      rate: this.tierBenefits[tier].rate,
    }));

    return {
      storeId: store.id,
      loyaltyTier: store.loyaltyTier,
      computedTierCap: store.loyaltyTier === StoreLoyaltyTier.ELITE ? StoreLoyaltyTier.ELITE : autoTier,
      performanceScore: Number(store.performanceScore),
      rankingBreakdown: {
        levelWeight: 0.4,
        ratingWeight: 0.4,
        responseWeight: 0.2,
        rating: Number(store.rating),
        avgResponseScore: Number(store.avgResponseScore),
      },
      subscription: {
        tier: store.subscriptionTier,
        active: store.subscriptionActive,
        effective: subEffective,
        expiresAt: store.subscriptionExpiresAt,
      },
      completedOrdersCount: store.completedOrdersCount,
      violationPoints: store.owner.violationScore,
      violationLimits: {
        freezeAt: 50,
        suspendAt: 80,
      },
      lifetimeEarnings: Number(store.lifetimeEarnings),
      referralCode: store.owner.referralCode,
      currentTierBenefits: tierRow.benefits,
      profitRate: tierRow.rate,
      benefitsByTier: benefitsTable,
      progressToNext: progress,
      thresholds: {
        silver: { minRating: 3.5, maxViolationPoints: 39, needsPaidSubscription: true },
        gold: {
          minRating: 4.0,
          maxViolationPoints: 24,
          minCompletedOrders: GOLD_MIN_COMPLETED_ORDERS,
          minAccountAgeDays: GOLD_MIN_ACCOUNT_AGE_DAYS,
          minSubscriptionTier: StoreSubscriptionTier.STANDARD,
        },
        vip: {
          minRating: 4.5,
          maxViolationPoints: 9,
          minCompletedOrders: VIP_MIN_COMPLETED_ORDERS,
          minSubscriptionTier: StoreSubscriptionTier.PREMIUM,
        },
      },
    };
  }

  private nextTier(current: StoreLoyaltyTier): StoreLoyaltyTier | null {
    if (current === StoreLoyaltyTier.ELITE) return null;
    const order: StoreLoyaltyTier[] = [
      StoreLoyaltyTier.BASIC,
      StoreLoyaltyTier.SILVER,
      StoreLoyaltyTier.GOLD,
      StoreLoyaltyTier.VIP,
      StoreLoyaltyTier.ELITE,
    ];
    const idx = order.indexOf(current);
    if (idx < 0 || idx >= order.length - 1) return null;
    return order[idx + 1];
  }

  private buildProgressSnapshot(p: {
    currentTier: StoreLoyaltyTier;
    nextTier: StoreLoyaltyTier | null;
    rating: number;
    violationPoints: number;
    completedOrders: number;
    storeCreatedAt: Date;
    subscriptionTier: StoreSubscriptionTier;
    subscriptionEffective: boolean;
  }) {
    if (!p.nextTier) {
      return {
        nextTier: null,
        percent: 100,
        summaryAr: 'أنت على أعلى مستوى متاح تلقائياً.',
        summaryEn: 'You are at the highest auto-assigned tier.',
        remaining: {} as Record<string, number | boolean | string>,
      };
    }

    const remaining: Record<string, number | boolean | string> = {};
    let steps = 0;
    let done = 0;

    const need = (cond: boolean) => {
      steps++;
      if (cond) done++;
    };

    if (p.nextTier === StoreLoyaltyTier.SILVER) {
      need(p.rating >= 3.5);
      need(p.violationPoints < 40);
      need(p.subscriptionEffective);
      remaining.ratingGap = Math.max(0, 3.5 - p.rating);
      remaining.violationHeadroom = Math.max(0, 40 - p.violationPoints);
    } else if (p.nextTier === StoreLoyaltyTier.GOLD) {
      need(p.rating >= 4.0);
      need(p.violationPoints < 25);
      need(
        p.subscriptionTier === StoreSubscriptionTier.STANDARD ||
          p.subscriptionTier === StoreSubscriptionTier.PREMIUM,
      );
      need(p.subscriptionEffective);
      need(p.completedOrders >= GOLD_MIN_COMPLETED_ORDERS);
      const ageDays =
        (Date.now() - p.storeCreatedAt.getTime()) / (24 * 60 * 60 * 1000);
      need(ageDays >= GOLD_MIN_ACCOUNT_AGE_DAYS);
      remaining.ordersToGold = Math.max(0, GOLD_MIN_COMPLETED_ORDERS - p.completedOrders);
      remaining.daysToGoldAge = Math.max(0, GOLD_MIN_ACCOUNT_AGE_DAYS - ageDays);
      remaining.ratingGap = Math.max(0, 4.0 - p.rating);
    } else if (p.nextTier === StoreLoyaltyTier.VIP) {
      need(p.rating >= 4.5);
      need(p.violationPoints < 10);
      need(p.subscriptionTier === StoreSubscriptionTier.PREMIUM);
      need(p.subscriptionEffective);
      need(p.completedOrders >= VIP_MIN_COMPLETED_ORDERS);
      remaining.ordersToVip = Math.max(0, VIP_MIN_COMPLETED_ORDERS - p.completedOrders);
      remaining.ratingGap = Math.max(0, 4.5 - p.rating);
    } else if (p.nextTier === StoreLoyaltyTier.ELITE) {
      return {
        nextTier: StoreLoyaltyTier.ELITE,
        percent: 0,
        summaryAr: 'مستوى ELITE يتم عبر دعوة من المنصة فقط.',
        summaryEn: 'ELITE tier is invite-only.',
        remaining: {},
      };
    }

    const percent = steps > 0 ? Math.round((done / steps) * 100) : 0;
    return {
      nextTier: p.nextTier,
      percent,
      summaryAr: `المستوى التالي: ${p.nextTier}`,
      summaryEn: `Next tier: ${p.nextTier}`,
      remaining,
    };
  }

  /** Nightly full scan — no notifications / realtime (idempotent reconciliation). */
  async recalculateAllActiveStoresBatch() {
    const take = 150;
    let skip = 0;
    let total = 0;
    for (;;) {
      const stores = await this.prisma.store.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true },
        take,
        skip,
      });
      if (!stores.length) break;
      for (const s of stores) {
        try {
          await this.recalculateAndPersist(s.id, {
            skipNotifications: true,
            skipRealtime: true,
          });
        } catch (e) {
          this.logger.error(`Batch recalc failed for ${s.id}`, e);
        }
      }
      total += stores.length;
      skip += take;
    }
    return { processed: total };
  }
}
