import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EXCLUDED_ORDER_STATUSES_FOR_PURCHASES } from './customer-wallet-metrics.util';

export interface AdminDateRange {
  startDate: Date | null;
  endDate: Date | null;
}

export interface AdminFinancialKpis {
  grossSales: number;
  netSales: number;
  totalSales: number;
  grossCommission: number;
  netCommission: number;
  netPlatformPosition: number;
  platformRevenue: number;
  platformCommissionBalance: number;
  platformFeesBalance: number;
  shippingCollected: number;
  shippingRevenue: number;
  shippingProfit: number;
  referralPaidOut: number;
  referralEarnings: number;
  referralCount: number;
  loyaltyCashbackPaid: number;
  pendingWithdrawals: number;
  pendingWithdrawalsCount: number;
  frozenFunds: number;
  totalRefunds: number;
  fullRefunds: number;
  partialRefunds: number;
  gatewayFees: number;
  pendingLiabilities: number;
  loyaltyPointsOutstanding: number;
  customerRewardsInWallets: number;
  opsLast24h: number;
  failedUnsettledCount: number;
  reconciliationDelta: number;
  todayTransactionsCount: number;
}

export interface SalesTrendPoint {
  date: string;
  grossSales: number;
  netSales: number;
}

export function buildAdminDateRange(filters?: {
  startDate?: string;
  endDate?: string;
}): AdminDateRange {
  const startDate = filters?.startDate ? new Date(filters.startDate) : null;
  const endDate = filters?.endDate ? new Date(filters.endDate) : null;
  if (endDate) endDate.setHours(23, 59, 59, 999);
  return { startDate, endDate };
}

export function buildPaymentDateFilter(range: AdminDateRange): Prisma.DateTimeFilter | undefined {
  if (!range.startDate && !range.endDate) return undefined;
  const filter: Prisma.DateTimeFilter = {};
  if (range.startDate) filter.gte = range.startDate;
  if (range.endDate) filter.lte = range.endDate;
  return filter;
}

/** SUCCESS payments on non-cancelled/refunded orders — audit-grade GMV base. */
export function buildGrossSalesPaymentWhere(
  range: AdminDateRange,
): Prisma.PaymentTransactionWhereInput {
  const dateFilter = buildPaymentDateFilter(range);
  return {
    status: 'SUCCESS',
    order: { status: { notIn: [...EXCLUDED_ORDER_STATUSES_FOR_PURCHASES] } },
    ...(dateFilter
      ? {
          OR: [
            { paidAt: dateFilter },
            { paidAt: null, createdAt: dateFilter },
          ],
        }
      : {}),
  };
}

/** Previous period of equal length, ending the day before range.startDate. */
export function buildPreviousAdminDateRange(
  range: AdminDateRange,
): AdminDateRange {
  if (!range.startDate || !range.endDate) {
    return { startDate: null, endDate: null };
  }
  const periodMs = range.endDate.getTime() - range.startDate.getTime();
  const prevEnd = new Date(range.startDate.getTime() - 1);
  prevEnd.setHours(23, 59, 59, 999);
  const prevStart = new Date(prevEnd.getTime() - periodMs);
  prevStart.setHours(0, 0, 0, 0);
  return { startDate: prevStart, endDate: prevEnd };
}

export function roundMoney(value: number): number {
  return Number(value.toFixed(2));
}

export async function computeAdminFinancialKpis(
  prisma: PrismaService,
  range: AdminDateRange,
): Promise<AdminFinancialKpis> {
  const grossSalesWhere = buildGrossSalesPaymentWhere(range);
  const dateFilter = buildPaymentDateFilter(range);
  const walletDate = dateFilter ? { createdAt: dateFilter } : {};

  const [
    grossSalesAgg,
    commissionAgg,
    shippingAgg,
    referralAgg,
    referralCountResult,
    pendingWithdrawalsAgg,
    fullRefundsAgg,
    partialRefundsAgg,
    gatewayFeesAgg,
    loyaltyPointsAgg,
    platformWallet,
    customerBalanceAgg,
    merchantStoreAgg,
    customerRewardsAgg,
    loyaltyPaidAgg,
    opsLast24h,
    failedUnsettledCount,
  ] = await Promise.all([
    prisma.paymentTransaction.aggregate({
      where: grossSalesWhere,
      _sum: { totalAmount: true },
    }),
    prisma.paymentTransaction.aggregate({
      where: grossSalesWhere,
      _sum: { commission: true },
    }),
    prisma.paymentTransaction.aggregate({
      where: grossSalesWhere,
      _sum: { shippingCost: true },
    }),
    prisma.walletTransaction.aggregate({
      where: {
        type: 'CREDIT',
        transactionType: 'REFERRAL_PROFIT',
        ...walletDate,
      },
      _sum: { amount: true },
    }),
    prisma.walletTransaction.count({
      where: {
        type: 'CREDIT',
        transactionType: 'REFERRAL_PROFIT',
        ...walletDate,
      },
    }),
    prisma.withdrawalRequest.aggregate({
      where: { status: 'PENDING' },
      _sum: { amount: true },
      _count: { id: true },
    }),
    prisma.paymentTransaction.aggregate({
      where: {
        status: 'REFUNDED',
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
      _sum: { refundedAmount: true },
    }),
    prisma.paymentTransaction.aggregate({
      where: {
        status: 'SUCCESS',
        refundedAmount: { gt: 0 },
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
      _sum: { refundedAmount: true },
    }),
    prisma.paymentTransaction.aggregate({
      where: grossSalesWhere,
      _sum: { gatewayFee: true },
    }),
    prisma.user.aggregate({ _sum: { loyaltyPoints: true } }),
    prisma.platformWallet.findFirst(),
    prisma.user.aggregate({ _sum: { customerBalance: true } }),
    prisma.store.aggregate({
      _sum: { balance: true, pendingBalance: true, frozenBalance: true },
    }),
    prisma.walletTransaction.aggregate({
      where: {
        role: 'CUSTOMER',
        type: 'CREDIT',
        transactionType: { in: ['ORDER_PROFIT', 'REFERRAL_PROFIT'] },
      },
      _sum: { amount: true },
    }),
    prisma.walletTransaction.aggregate({
      where: {
        role: 'CUSTOMER',
        type: 'CREDIT',
        transactionType: 'ORDER_PROFIT',
        ...walletDate,
      },
      _sum: { amount: true },
    }),
    computeOpsLast24h(prisma),
    prisma.paymentTransaction.count({
      where: {
        status: 'FAILED',
        refundedAmount: 0,
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
    }),
  ]);

  const grossSales = Number(grossSalesAgg._sum.totalAmount || 0);
  const grossCommission = Number(commissionAgg._sum.commission || 0);
  const totalReferralPaid = Number(referralAgg._sum.amount || 0);
  const totalLoyaltyPaid = Number(loyaltyPaidAgg._sum.amount || 0);
  const totalGatewayFees = Number(gatewayFeesAgg._sum?.gatewayFee || 0);
  const fullRefunds = Number(fullRefundsAgg._sum.refundedAmount || 0);
  const partialRefunds = Number(partialRefundsAgg._sum.refundedAmount || 0);
  const totalRefunds = fullRefunds + partialRefunds;
  const netSales = grossSales - totalRefunds;
  const shippingCollected = Number(shippingAgg._sum.shippingCost || 0);

  const netCommission = grossCommission - totalReferralPaid - totalLoyaltyPaid - totalGatewayFees;
  const netPlatformPosition = netCommission - totalRefunds;

  const platformCommissionBal = Number(platformWallet?.commissionBalance || 0);
  const platformFeesBal = Number(platformWallet?.feesBalance || 0);
  const platformTotalRevenue = Number(platformWallet?.totalRevenue || 0);
  const reconciliationDelta = roundMoney(netCommission - platformCommissionBal);

  const merchantEscrowHeld =
    Number(merchantStoreAgg._sum.pendingBalance || 0) +
    Number(merchantStoreAgg._sum.frozenBalance || 0);
  const userWalletLiabilitiesAed =
    Number(customerBalanceAgg._sum.customerBalance || 0) +
    Number(merchantStoreAgg._sum.balance || 0);

  return {
    grossSales: roundMoney(grossSales),
    netSales: roundMoney(netSales),
    totalSales: roundMoney(grossSales),
    grossCommission: roundMoney(grossCommission),
    netCommission: roundMoney(netCommission),
    netPlatformPosition: roundMoney(netPlatformPosition),
    platformRevenue: roundMoney(platformTotalRevenue),
    platformCommissionBalance: roundMoney(platformCommissionBal),
    platformFeesBalance: roundMoney(platformFeesBal),
    shippingCollected: roundMoney(shippingCollected),
    shippingRevenue: roundMoney(shippingCollected),
    shippingProfit: roundMoney(shippingCollected),
    referralPaidOut: roundMoney(totalReferralPaid),
    referralEarnings: roundMoney(totalReferralPaid),
    referralCount: referralCountResult,
    loyaltyCashbackPaid: roundMoney(totalLoyaltyPaid),
    pendingWithdrawals: roundMoney(Number(pendingWithdrawalsAgg._sum.amount || 0)),
    pendingWithdrawalsCount: pendingWithdrawalsAgg._count.id,
    frozenFunds: roundMoney(merchantEscrowHeld),
    totalRefunds: roundMoney(totalRefunds),
    fullRefunds: roundMoney(fullRefunds),
    partialRefunds: roundMoney(partialRefunds),
    gatewayFees: roundMoney(totalGatewayFees),
    pendingLiabilities: roundMoney(userWalletLiabilitiesAed),
    loyaltyPointsOutstanding: Number(loyaltyPointsAgg._sum?.loyaltyPoints || 0),
    customerRewardsInWallets: roundMoney(Number(customerRewardsAgg._sum.amount || 0)),
    opsLast24h,
    failedUnsettledCount,
    reconciliationDelta,
    todayTransactionsCount: opsLast24h,
  };
}

async function computeOpsLast24h(prisma: PrismaService): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dateWhere = { createdAt: { gte: since } };
  const [payments, wallet, escrow, withdrawals] = await Promise.all([
    prisma.paymentTransaction.count({ where: dateWhere }),
    prisma.walletTransaction.count({ where: dateWhere }),
    prisma.escrowTransaction.count({ where: dateWhere }),
    prisma.withdrawalRequest.count({ where: dateWhere }),
  ]);
  return payments + wallet + escrow + withdrawals;
}

export async function computeSalesTrend(
  prisma: PrismaService,
  range: AdminDateRange,
): Promise<SalesTrendPoint[]> {
  const { startDate, endDate } = range;

  const rows =
    startDate && endDate
      ? await prisma.$queryRaw<Array<{ day: Date; gross: unknown; refunds: unknown }>>`
          SELECT
            DATE(COALESCE(pt."paid_at", pt."created_at")) AS day,
            COALESCE(SUM(pt."total_amount"), 0) AS gross,
            COALESCE(SUM(pt."refunded_amount"), 0) AS refunds
          FROM "payment_transactions" pt
          JOIN "orders" o ON o."id" = pt."order_id"
          WHERE pt."status" = 'SUCCESS'
            AND o."status" NOT IN ('CANCELLED', 'REFUNDED')
            AND COALESCE(pt."paid_at", pt."created_at") BETWEEN ${startDate} AND ${endDate}
          GROUP BY DATE(COALESCE(pt."paid_at", pt."created_at"))
          ORDER BY day ASC`
      : await prisma.$queryRaw<Array<{ day: Date; gross: unknown; refunds: unknown }>>`
          SELECT
            DATE(COALESCE(pt."paid_at", pt."created_at")) AS day,
            COALESCE(SUM(pt."total_amount"), 0) AS gross,
            COALESCE(SUM(pt."refunded_amount"), 0) AS refunds
          FROM "payment_transactions" pt
          JOIN "orders" o ON o."id" = pt."order_id"
          WHERE pt."status" = 'SUCCESS'
            AND o."status" NOT IN ('CANCELLED', 'REFUNDED')
          GROUP BY DATE(COALESCE(pt."paid_at", pt."created_at"))
          ORDER BY day ASC`;

  return rows.map((r) => {
    const gross = Number(r.gross || 0);
    const refunds = Number(r.refunds || 0);
    const day = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day);
    return {
      date: day,
      grossSales: roundMoney(gross),
      netSales: roundMoney(gross - refunds),
    };
  });
}

export async function computeTopSpenders(
  prisma: PrismaService,
  range: AdminDateRange,
  limit = 5,
) {
  const { startDate, endDate } = range;

  const raw =
    startDate && endDate
      ? await prisma.$queryRaw<
          Array<{ customerId: string; totalAmount: unknown; ordersCount: bigint }>
        >`
          SELECT
            pt."customer_id" AS "customerId",
            SUM(pt."total_amount") AS "totalAmount",
            COUNT(DISTINCT pt."order_id") AS "ordersCount"
          FROM "payment_transactions" pt
          JOIN "orders" o ON o."id" = pt."order_id"
          WHERE pt."status" = 'SUCCESS'
            AND pt."customer_id" IS NOT NULL
            AND o."status" NOT IN ('CANCELLED', 'REFUNDED')
            AND COALESCE(pt."paid_at", pt."created_at") BETWEEN ${startDate} AND ${endDate}
          GROUP BY pt."customer_id"
          ORDER BY "totalAmount" DESC
          LIMIT ${limit}`
      : await prisma.$queryRaw<
          Array<{ customerId: string; totalAmount: unknown; ordersCount: bigint }>
        >`
          SELECT
            pt."customer_id" AS "customerId",
            SUM(pt."total_amount") AS "totalAmount",
            COUNT(DISTINCT pt."order_id") AS "ordersCount"
          FROM "payment_transactions" pt
          JOIN "orders" o ON o."id" = pt."order_id"
          WHERE pt."status" = 'SUCCESS'
            AND pt."customer_id" IS NOT NULL
            AND o."status" NOT IN ('CANCELLED', 'REFUNDED')
          GROUP BY pt."customer_id"
          ORDER BY "totalAmount" DESC
          LIMIT ${limit}`;

  const spenderIds = raw.map((s) => s.customerId).filter(Boolean);
  const spenderUsers = await prisma.user.findMany({
    where: { id: { in: spenderIds } },
    select: { id: true, name: true, avatar: true },
  });

  return raw.map((s) => {
    const user = spenderUsers.find((u) => u.id === s.customerId);
    return {
      id: s.customerId,
      name: user?.name || 'Unknown',
      avatar: user?.avatar || null,
      totalSpent: roundMoney(Number(s.totalAmount || 0)),
      ordersCount: Number(s.ordersCount || 0),
    };
  });
}

export async function computeTopEarners(
  prisma: PrismaService,
  range: AdminDateRange,
  limit = 5,
) {
  const { startDate, endDate } = range;

  const raw =
    startDate && endDate
      ? await prisma.$queryRaw<
          Array<{ storeId: string; totalAmount: unknown; ordersCount: bigint }>
        >`
          SELECT
            off."store_id" AS "storeId",
            SUM(pt."unit_price") AS "totalAmount",
            COUNT(DISTINCT pt."order_id") AS "ordersCount"
          FROM "payment_transactions" pt
          JOIN "offers" off ON pt."offer_id" = off."id"
          JOIN "orders" o ON o."id" = pt."order_id"
          WHERE pt."status" = 'SUCCESS'
            AND off."store_id" IS NOT NULL
            AND o."status" NOT IN ('CANCELLED', 'REFUNDED')
            AND COALESCE(pt."paid_at", pt."created_at") BETWEEN ${startDate} AND ${endDate}
          GROUP BY off."store_id"
          ORDER BY "totalAmount" DESC
          LIMIT ${limit}`
      : await prisma.$queryRaw<
          Array<{ storeId: string; totalAmount: unknown; ordersCount: bigint }>
        >`
          SELECT
            off."store_id" AS "storeId",
            SUM(pt."unit_price") AS "totalAmount",
            COUNT(DISTINCT pt."order_id") AS "ordersCount"
          FROM "payment_transactions" pt
          JOIN "offers" off ON pt."offer_id" = off."id"
          JOIN "orders" o ON o."id" = pt."order_id"
          WHERE pt."status" = 'SUCCESS'
            AND off."store_id" IS NOT NULL
            AND o."status" NOT IN ('CANCELLED', 'REFUNDED')
          GROUP BY off."store_id"
          ORDER BY "totalAmount" DESC
          LIMIT ${limit}`;

  const storeIds = raw.map((e) => e.storeId).filter(Boolean);
  const earnerStores = await prisma.store.findMany({
    where: { id: { in: storeIds } },
    select: { id: true, name: true, logo: true, rating: true },
  });

  return raw.map((e) => {
    const store = earnerStores.find((s) => s.id === e.storeId);
    return {
      id: e.storeId,
      name: store?.name || 'Unknown Store',
      logo: store?.logo || null,
      rating: store?.rating || 0,
      totalEarned: roundMoney(Number(e.totalAmount || 0)),
      ordersCount: Number(e.ordersCount || 0),
    };
  });
}
