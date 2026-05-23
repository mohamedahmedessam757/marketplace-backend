import { PrismaService } from '../prisma/prisma.service';

export const MERCHANT_NET_DEBIT_TYPES = new Set([
  'SHIPPING_FEE',
  'ADJUDICATION_FEE',
  'REFUND',
  'PENALTY',
  'FRAUD_PENALTY',
  'WITHDRAWAL',
]);

export const EXCLUDED_ORDER_STATUSES_FOR_SALES = ['CANCELLED', 'REFUNDED'] as const;

export interface VendorLedgerTx {
  amount: number | string | { toString(): string };
  type: string;
  transactionType: string | null;
  paymentId?: string | null;
  escrowId?: string | null;
}

/** Net ledger profit: merchant credits (sales + referrals) minus debits. */
export function computeLedgerNetProfit(vendorTxs: VendorLedgerTx[]): number {
  let ledgerNet = 0;

  for (const action of vendorTxs) {
    const amount = Number(action.amount);
    const txType = String(action.transactionType || '').toUpperCase();

    if (action.type === 'CREDIT') {
      if (txType === 'REFERRAL_PROFIT') {
        ledgerNet += amount;
      } else if (
        txType === 'PAYMENT' ||
        txType === 'SALE' ||
        txType === 'COMMISSION' ||
        (action.escrowId && action.paymentId)
      ) {
        ledgerNet += amount;
      }
    } else if (action.type === 'DEBIT' && MERCHANT_NET_DEBIT_TYPES.has(txType)) {
      ledgerNet -= amount;
    }
  }

  return Math.max(0, Number(ledgerNet.toFixed(2)));
}

/** Merchant gross sales = SUM(unitPrice) for successful payments on this store's offers. */
export async function computeMerchantGrossSales(
  prisma: PrismaService,
  storeId: string,
): Promise<number> {
  const agg = await prisma.paymentTransaction.aggregate({
    where: {
      status: 'SUCCESS',
      offer: { storeId },
      order: { status: { notIn: [...EXCLUDED_ORDER_STATUSES_FOR_SALES] } },
    },
    _sum: { unitPrice: true },
  });
  return Number(agg._sum.unitPrice || 0);
}

/**
 * Distinct paid orders for this merchant (multi-part safe via offer.storeId).
 */
export async function computeCompletedOrdersCount(
  prisma: PrismaService,
  storeId: string,
): Promise<number> {
  const payments = await prisma.paymentTransaction.findMany({
    where: {
      status: 'SUCCESS',
      offer: { storeId },
      order: {
        status: { notIn: [...EXCLUDED_ORDER_STATUSES_FOR_SALES] },
        OR: [
          { status: { in: ['COMPLETED', 'DELIVERED'] } },
          {
            escrowTransactions: {
              some: { status: { in: ['HELD', 'RELEASED', 'FROZEN'] } },
            },
          },
        ],
      },
    },
    select: { orderId: true },
    distinct: ['orderId'],
  });
  return payments.length;
}

/** Persist lifetime_earnings + completed_orders_count from payment aggregates. */
export async function reconcileStoreCounters(
  prisma: PrismaService,
  storeId: string,
): Promise<{ lifetimeEarnings: number; completedOrdersCount: number }> {
  const [lifetimeEarnings, completedOrdersCount] = await Promise.all([
    computeMerchantGrossSales(prisma, storeId),
    computeCompletedOrdersCount(prisma, storeId),
  ]);

  await prisma.store.update({
    where: { id: storeId },
    data: {
      lifetimeEarnings,
      completedOrdersCount,
    },
  });

  return { lifetimeEarnings, completedOrdersCount };
}

/** Per-store merchant share from an order's successful payments (multi-part). */
export function sumMerchantShareByStore(
  payments: Array<{ unitPrice: unknown; offer?: { storeId: string | null } | null }>,
): Map<string, number> {
  const byStore = new Map<string, number>();
  for (const p of payments) {
    const storeId = p.offer?.storeId;
    if (!storeId) continue;
    byStore.set(storeId, (byStore.get(storeId) || 0) + Number(p.unitPrice || 0));
  }
  return byStore;
}
