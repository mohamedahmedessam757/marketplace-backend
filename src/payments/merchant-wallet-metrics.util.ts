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

/** Sale recognition on merchant ledger — payment capture only, not escrow release to available. */
function isMerchantSaleLedgerCredit(action: VendorLedgerTx): boolean {
  if (action.type !== 'CREDIT') return false;
  const txType = String(action.transactionType || '').toUpperCase();
  if (txType === 'REFERRAL_PROFIT') return false;
  if (txType === 'ESCROW_RELEASE' || txType === 'ESCROW_TRANSFER') return false;
  if (txType === 'COMMISSION') return false;
  return (txType === 'PAYMENT' || txType === 'SALE') && !!action.paymentId;
}

/** Net ledger profit: unique sale credits + referrals minus debits (no double-count on escrow release). */
export function computeLedgerNetProfit(vendorTxs: VendorLedgerTx[]): number {
  let ledgerNet = 0;
  const salePaymentsSeen = new Set<string>();

  for (const action of vendorTxs) {
    const amount = Number(action.amount);
    const txType = String(action.transactionType || '').toUpperCase();

    if (action.type === 'CREDIT') {
      if (txType === 'REFERRAL_PROFIT') {
        ledgerNet += amount;
      } else if (isMerchantSaleLedgerCredit(action)) {
        const key = action.paymentId as string;
        if (salePaymentsSeen.has(key)) continue;
        salePaymentsSeen.add(key);
        ledgerNet += amount;
      }
    } else if (action.type === 'DEBIT' && MERCHANT_NET_DEBIT_TYPES.has(txType)) {
      ledgerNet -= amount;
    }
  }

  return Math.max(0, Number(ledgerNet.toFixed(2)));
}

/**
 * Merchant gross sales = sum of unitPrice per accepted offer (one row per offer).
 * Duplicate SUCCESS payments for the same offer (legacy invoice bugs) count once.
 */
export async function computeMerchantGrossSales(
  prisma: PrismaService,
  storeId: string,
): Promise<number> {
  const payments = await prisma.paymentTransaction.findMany({
    where: {
      status: 'SUCCESS',
      offer: { storeId },
      order: { status: { notIn: [...EXCLUDED_ORDER_STATUSES_FOR_SALES] } },
    },
    select: { offerId: true, unitPrice: true },
    orderBy: { createdAt: 'desc' },
  });

  const byOffer = new Map<string, number>();
  for (const p of payments) {
    if (!p.offerId) continue;
    if (!byOffer.has(p.offerId)) {
      byOffer.set(p.offerId, Number(p.unitPrice || 0));
    }
  }

  let sum = 0;
  for (const unitPrice of byOffer.values()) {
    sum += unitPrice;
  }
  return Number(sum.toFixed(2));
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

export interface MerchantEscrowBalances {
  pending: number;
  frozen: number;
}

/** Pending/frozen from HELD/FROZEN escrow rows (source of truth for merchant escrow). */
export async function computeMerchantEscrowBalances(
  prisma: PrismaService,
  storeId: string,
): Promise<MerchantEscrowBalances> {
  const rows = await prisma.escrowTransaction.groupBy({
    by: ['status'],
    where: {
      status: { in: ['HELD', 'FROZEN'] },
      payment: { offer: { storeId } },
    },
    _sum: { merchantAmount: true },
  });

  let pending = 0;
  let frozen = 0;
  for (const row of rows) {
    const amt = Number(row._sum.merchantAmount || 0);
    if (row.status === 'HELD') pending = amt;
    else if (row.status === 'FROZEN') frozen = amt;
  }

  return {
    pending: Number(pending.toFixed(2)),
    frozen: Number(frozen.toFixed(2)),
  };
}

/** Align store.pending_balance / frozen_balance with escrow aggregates when drifted. */
export async function reconcileStoreWalletFromEscrow(
  prisma: PrismaService,
  storeId: string,
): Promise<MerchantEscrowBalances> {
  const balances = await computeMerchantEscrowBalances(prisma, storeId);
  await prisma.store.update({
    where: { id: storeId },
    data: {
      pendingBalance: balances.pending,
      frozenBalance: balances.frozen,
    },
  });
  return balances;
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
