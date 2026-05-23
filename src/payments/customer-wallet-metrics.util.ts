import { PrismaService } from '../prisma/prisma.service';

export const CUSTOMER_NET_DEBIT_TYPES = new Set([
  'SHIPPING_FEE',
  'PENALTY',
  'WITHDRAWAL',
]);

export const EXCLUDED_ORDER_STATUSES_FOR_PURCHASES = ['CANCELLED', 'REFUNDED'] as const;

export const CUSTOMER_PENDING_ORDER_STATUSES = [
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
] as const;

export const REFERRAL_WINDOW_DAYS = 180;
export const REFERRAL_RATE = 0.01;

export const CUSTOMER_TIER_CASHBACK: Record<string, number> = {
  BASIC: 0.02,
  SILVER: 0.03,
  GOLD: 0.04,
  VIP: 0.05,
  PARTNER: 0.06,
};

export interface CustomerLedgerTx {
  amount: number | string | { toString(): string };
  type: string;
  transactionType: string | null;
}

export interface RewardSplitAggregates {
  lifetimeLoyalty: number;
  lifetimeReferral: number;
  monthlyLoyalty: number;
  monthlyReferral: number;
}

/** Net rewards: loyalty + referral credits minus wallet debits. */
export function computeLedgerNetRewards(txs: CustomerLedgerTx[]): number {
  let net = 0;
  for (const tx of txs) {
    const amount = Number(tx.amount);
    const txType = String(tx.transactionType || '').toUpperCase();
    if (tx.type === 'CREDIT' && (txType === 'ORDER_PROFIT' || txType === 'REFERRAL_PROFIT')) {
      net += amount;
    } else if (tx.type === 'DEBIT' && CUSTOMER_NET_DEBIT_TYPES.has(txType)) {
      net -= amount;
    }
  }
  return Number(net.toFixed(2));
}

/** Gross purchases = SUM(totalAmount) for SUCCESS payments on non-cancelled/refunded orders. */
export async function computeCustomerTotalPurchases(
  prisma: PrismaService,
  customerId: string,
): Promise<number> {
  const agg = await prisma.paymentTransaction.aggregate({
    where: {
      customerId,
      status: 'SUCCESS',
      order: { status: { notIn: [...EXCLUDED_ORDER_STATUSES_FOR_PURCHASES] } },
    },
    _sum: { totalAmount: true },
  });
  return Number(agg._sum.totalAmount || 0);
}

export async function computeCustomerCompletedOrdersCount(
  prisma: PrismaService,
  customerId: string,
): Promise<number> {
  return prisma.order.count({
    where: { customerId, status: 'COMPLETED' },
  });
}

/** Includes partial refunds on SUCCESS payments plus full REFUNDED rows. */
export async function computeRefundedAmount(
  prisma: PrismaService,
  customerId: string,
): Promise<number> {
  const [partial, full] = await Promise.all([
    prisma.paymentTransaction.aggregate({
      where: {
        customerId,
        status: 'SUCCESS',
        refundedAmount: { gt: 0 },
      },
      _sum: { refundedAmount: true },
    }),
    prisma.paymentTransaction.aggregate({
      where: { customerId, status: 'REFUNDED' },
      _sum: { refundedAmount: true },
    }),
  ]);
  return Number(partial._sum.refundedAmount || 0) + Number(full._sum.refundedAmount || 0);
}

export function splitRewardAggregates(
  txs: Array<{
    amount: unknown;
    type: string;
    transactionType: string | null;
    createdAt: Date;
  }>,
  startOfMonth: Date,
): RewardSplitAggregates {
  const result: RewardSplitAggregates = {
    lifetimeLoyalty: 0,
    lifetimeReferral: 0,
    monthlyLoyalty: 0,
    monthlyReferral: 0,
  };

  for (const tx of txs) {
    const amount = Number(tx.amount);
    const txType = String(tx.transactionType || '').toUpperCase();
    if (tx.type !== 'CREDIT') continue;

    const isMonthly = tx.createdAt >= startOfMonth;
    if (txType === 'ORDER_PROFIT') {
      result.lifetimeLoyalty += amount;
      if (isMonthly) result.monthlyLoyalty += amount;
    } else if (txType === 'REFERRAL_PROFIT') {
      result.lifetimeReferral += amount;
      if (isMonthly) result.monthlyReferral += amount;
    }
  }

  for (const key of Object.keys(result) as (keyof RewardSplitAggregates)[]) {
    result[key] = Number(result[key].toFixed(2));
  }
  return result;
}

/** Legacy rows: referralStartsAt null falls back to user createdAt. */
export function buildActiveReferralWindowFilter(windowCutoff: Date) {
  return {
    OR: [
      { referralStartsAt: { gte: windowCutoff } },
      { referralStartsAt: null, createdAt: { gte: windowCutoff } },
    ],
  };
}

export function computePendingLoyaltyFromOrders(
  pendingOrders: Array<{ payments: Array<{ commission?: unknown }> }>,
  tierCashbackRate: number,
): number {
  return Number(
    pendingOrders
      .reduce((sum, order) => {
        const commission = order.payments.reduce(
          (cSum, p) => cSum + Number(p.commission || 0),
          0,
        );
        return sum + commission * tierCashbackRate;
      }, 0)
      .toFixed(2),
  );
}

export function computePendingReferralFromOrders(
  pendingOrders: Array<{ payments: Array<{ unitPrice?: unknown }> }>,
): number {
  return Number(
    pendingOrders
      .reduce((sum, order) => {
        const subtotal = order.payments.reduce(
          (s, p) => s + Number(p.unitPrice || 0),
          0,
        );
        return sum + (subtotal > 0 ? subtotal * REFERRAL_RATE : 0);
      }, 0)
      .toFixed(2),
  );
}

/** Backfill users.total_spent from payment aggregates when drift detected. */
export async function reconcileUserTotalSpent(
  prisma: PrismaService,
  userId: string,
  purchasesFromPayments: number,
  currentTotalSpent: number,
): Promise<number> {
  if (
    purchasesFromPayments > 0 &&
    Math.abs(currentTotalSpent - purchasesFromPayments) > 0.01
  ) {
    await prisma.user
      .update({
        where: { id: userId },
        data: { totalSpent: purchasesFromPayments },
      })
      .catch(() => undefined);
    return purchasesFromPayments;
  }
  return currentTotalSpent;
}
