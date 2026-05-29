import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { buildAdminDateRange } from './admin-financial-metrics.util';

export interface FeedFilters {
  startDate?: string;
  endDate?: string;
  search?: string;
  type?: string;
  role?: string;
  limit?: number;
  cursor?: string;
}

export interface FeedCursor {
  sortAt: string;
  source: string;
  id: string;
}

export interface FeedIndexRow {
  source: string;
  id: string;
  sortAt: Date;
}

export function encodeFeedCursor(row: FeedIndexRow): string {
  return `${row.sortAt.toISOString()}|${row.source}|${row.id}`;
}

export function decodeFeedCursor(cursor?: string): FeedCursor | null {
  if (!cursor) return null;
  const parts = cursor.split('|');
  if (parts.length < 3) return null;
  const id = parts.slice(2).join('|');
  return { sortAt: parts[0], source: parts[1], id };
}

function matchesTypeFilter(source: string, eventType: string, filterType: string): boolean {
  if (filterType === 'ALL') return true;
  if (filterType === source) return true;
  if (source === 'WALLET' && eventType.toUpperCase() === filterType.toUpperCase()) return true;
  if (source === 'PAYMENT' && filterType === 'PAYMENT') return true;
  if (eventType === filterType) return true;
  return false;
}

function buildDateSql(range: ReturnType<typeof buildAdminDateRange>, column: string): Prisma.Sql {
  if (range.startDate && range.endDate) {
    return Prisma.sql`${Prisma.raw(column)} BETWEEN ${range.startDate} AND ${range.endDate}`;
  }
  if (range.startDate) {
    return Prisma.sql`${Prisma.raw(column)} >= ${range.startDate}`;
  }
  if (range.endDate) {
    return Prisma.sql`${Prisma.raw(column)} <= ${range.endDate}`;
  }
  return Prisma.sql`TRUE`;
}

function buildOuterCursorSql(cursor: FeedCursor | null): Prisma.Sql {
  if (!cursor) return Prisma.sql`TRUE`;
  const sortAt = new Date(cursor.sortAt);
  return Prisma.sql`(
    "sortAt" < ${sortAt}
    OR ("sortAt" = ${sortAt} AND source < ${cursor.source})
    OR ("sortAt" = ${sortAt} AND source = ${cursor.source} AND id < ${cursor.id})
  )`;
}

export async function fetchUnifiedFeedIndex(
  prisma: PrismaService,
  filters: FeedFilters,
): Promise<{ rows: FeedIndexRow[]; hasMore: boolean }> {
  const range = buildAdminDateRange(filters);
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 100);
  const cursor = decodeFeedCursor(filters.cursor);
  const search = filters.search?.trim();
  const typeFilter = filters.type && filters.type !== 'ALL' ? filters.type : null;
  const roleFilter = filters.role && filters.role !== 'ALL' ? filters.role : null;

  const includePayments =
    !typeFilter ||
    typeFilter === 'PAYMENT' ||
    typeFilter === 'PAYMENT_REFUNDED' ||
    typeFilter.startsWith('PAYMENT_');
  const includeWallet =
    !typeFilter ||
    typeFilter === 'WALLET' ||
    [
      'ORDER_PROFIT',
      'REFERRAL_PROFIT',
      'COMMISSION',
      'REFUND',
      'PENALTY',
      'SHIPPING_FEE',
      'MANUAL_PAYOUT',
    ].includes(typeFilter);
  const includeEscrow = !typeFilter || typeFilter === 'ESCROW';
  const includeWithdrawals = !typeFilter || typeFilter === 'WITHDRAWAL';

  const paymentSearch = search
    ? Prisma.sql`AND pt."transaction_number" ILIKE ${'%' + search + '%'}`
    : Prisma.empty;
  const walletSearch = search
    ? Prisma.sql`AND (wt."description" ILIKE ${'%' + search + '%'} OR wt."transaction_type" ILIKE ${'%' + search + '%'})`
    : Prisma.empty;
  const walletRole = roleFilter ? Prisma.sql`AND wt."role" = ${roleFilter}` : Prisma.empty;
  const walletType =
    typeFilter && typeFilter !== 'WALLET'
      ? Prisma.sql`AND UPPER(wt."transaction_type") = ${typeFilter.toUpperCase()}`
      : Prisma.empty;
  const withdrawalRole = roleFilter ? Prisma.sql`AND wr."role" = ${roleFilter}` : Prisma.empty;
  const withdrawalSearch = search
    ? Prisma.sql`AND CAST(wr."amount" AS TEXT) ILIKE ${'%' + search + '%'}`
    : Prisma.empty;

  const unions: Prisma.Sql[] = [];

  const paymentStatus =
    typeFilter === 'PAYMENT_REFUNDED'
      ? Prisma.sql`AND pt."status" = 'REFUNDED'`
      : typeFilter === 'PAYMENT'
        ? Prisma.sql`AND pt."status" = 'SUCCESS'`
        : Prisma.empty;

  if (includePayments) {
    unions.push(Prisma.sql`
      SELECT 'PAYMENT'::text AS source, pt."id"::text AS id,
             COALESCE(pt."paid_at", pt."created_at") AS "sortAt"
      FROM "payment_transactions" pt
      WHERE ${buildDateSql(range, 'COALESCE(pt."paid_at", pt."created_at")')}
        ${paymentSearch}
        ${paymentStatus}
    `);
  }

  if (includeWallet) {
    unions.push(Prisma.sql`
      SELECT 'WALLET'::text AS source, wt."id"::text AS id, wt."created_at" AS "sortAt"
      FROM "wallet_transactions" wt
      WHERE ${buildDateSql(range, 'wt."created_at"')}
        ${walletSearch}
        ${walletRole}
        ${walletType}
    `);
  }

  if (includeEscrow) {
    unions.push(Prisma.sql`
      SELECT 'ESCROW'::text AS source, et."id"::text AS id, et."created_at" AS "sortAt"
      FROM "escrow_transactions" et
      WHERE ${buildDateSql(range, 'et."created_at"')}
    `);
  }

  if (includeWithdrawals) {
    unions.push(Prisma.sql`
      SELECT 'WITHDRAWAL'::text AS source, wr."id"::text AS id, wr."created_at" AS "sortAt"
      FROM "withdrawal_requests" wr
      WHERE ${buildDateSql(range, 'wr."created_at"')}
        ${withdrawalRole}
        ${withdrawalSearch}
    `);
  }

  if (unions.length === 0) {
    return { rows: [], hasMore: false };
  }

  const unionSql = unions.reduce((acc, part, idx) =>
    idx === 0 ? part : Prisma.sql`${acc} UNION ALL ${part}`,
  );

  const rows = await prisma.$queryRaw<FeedIndexRow[]>`
    SELECT source, id, "sortAt"
    FROM (${unionSql}) AS unified
    WHERE ${buildOuterCursorSql(cursor)}
    ORDER BY "sortAt" DESC, source DESC, id DESC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  return { rows: pageRows, hasMore };
}

export async function countUnifiedFeed(
  prisma: PrismaService,
  filters: FeedFilters,
): Promise<number> {
  const range = buildAdminDateRange(filters);
  const search = filters.search?.trim();
  const typeFilter = filters.type && filters.type !== 'ALL' ? filters.type : null;
  const roleFilter = filters.role && filters.role !== 'ALL' ? filters.role : null;

  const includePayments =
    !typeFilter ||
    typeFilter === 'PAYMENT' ||
    typeFilter === 'PAYMENT_REFUNDED' ||
    typeFilter.startsWith('PAYMENT_');
  const includeWallet =
    !typeFilter ||
    typeFilter === 'WALLET' ||
    [
      'ORDER_PROFIT',
      'REFERRAL_PROFIT',
      'COMMISSION',
      'REFUND',
      'PENALTY',
      'SHIPPING_FEE',
      'MANUAL_PAYOUT',
    ].includes(typeFilter);
  const includeEscrow = !typeFilter || typeFilter === 'ESCROW';
  const includeWithdrawals = !typeFilter || typeFilter === 'WITHDRAWAL';

  const counts: number[] = [];

  if (includePayments) {
    const paymentSearch = search
      ? { transactionNumber: { contains: search, mode: 'insensitive' as const } }
      : {};
    const dateFilter =
      range.startDate || range.endDate
        ? {
            ...(range.startDate || range.endDate
              ? {
                  OR: [
                    { paidAt: { ...(range.startDate ? { gte: range.startDate } : {}), ...(range.endDate ? { lte: range.endDate } : {}) } },
                    {
                      paidAt: null,
                      createdAt: {
                        ...(range.startDate ? { gte: range.startDate } : {}),
                        ...(range.endDate ? { lte: range.endDate } : {}),
                      },
                    },
                  ],
                }
              : {}),
          }
        : undefined;
    counts.push(
      await prisma.paymentTransaction.count({
        where: {
          ...(dateFilter ? dateFilter : {}),
          ...paymentSearch,
        },
      }),
    );
  }

  if (includeWallet) {
    const dateFilter = range.startDate || range.endDate
      ? {
          ...(range.startDate ? { gte: range.startDate } : {}),
          ...(range.endDate ? { lte: range.endDate } : {}),
        }
      : undefined;
    counts.push(
      await prisma.walletTransaction.count({
        where: {
          ...(dateFilter ? { createdAt: dateFilter } : {}),
          ...(roleFilter ? { role: roleFilter } : {}),
          ...(typeFilter && typeFilter !== 'WALLET'
            ? { transactionType: { equals: typeFilter, mode: 'insensitive' } }
            : {}),
          ...(search
            ? {
                OR: [
                  { description: { contains: search, mode: 'insensitive' } },
                  { transactionType: { contains: search, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
      }),
    );
  }

  if (includeEscrow) {
    const dateFilter = range.startDate || range.endDate
      ? {
          ...(range.startDate ? { gte: range.startDate } : {}),
          ...(range.endDate ? { lte: range.endDate } : {}),
        }
      : undefined;
    counts.push(
      await prisma.escrowTransaction.count({
        where: dateFilter ? { createdAt: dateFilter } : {},
      }),
    );
  }

  if (includeWithdrawals) {
    const dateFilter = range.startDate || range.endDate
      ? {
          ...(range.startDate ? { gte: range.startDate } : {}),
          ...(range.endDate ? { lte: range.endDate } : {}),
        }
      : undefined;
    counts.push(
      await prisma.withdrawalRequest.count({
        where: {
          ...(dateFilter ? { createdAt: dateFilter } : {}),
          ...(roleFilter ? { role: roleFilter } : {}),
        },
      }),
    );
  }

  return counts.reduce((a, b) => a + b, 0);
}

export { matchesTypeFilter };
