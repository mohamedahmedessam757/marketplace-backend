/**
 * Unified Financial Feed DTO — 2026 Standard
 * Normalizes data from Payment, Wallet, Escrow, and Withdrawal tables
 * into a single structure for the Admin Financial Center.
 */

export enum FinancialEventSource {
  PAYMENT = 'PAYMENT',
  WALLET = 'WALLET',
  ESCROW = 'ESCROW',
  WITHDRAWAL = 'WITHDRAWAL',
}

export enum FinancialDirection {
  CREDIT = 'CREDIT',
  DEBIT = 'DEBIT',
  HOLD = 'HOLD',
  RELEASE = 'RELEASE',
  FREEZE = 'FREEZE',
}

export type FinancialImpact =
  | 'PLATFORM_REVENUE'
  | 'PLATFORM_EXPENSE'
  | 'USER_LIABILITY'
  | 'NEUTRAL';

export interface UnifiedFinancialEventDto {
  id: string;
  source: FinancialEventSource;

  orderId?: string;
  orderNumber?: string;

  customerId?: string;
  customerName?: string;
  customerCode?: string;
  customerAvatar?: string;

  storeId?: string;
  storeName?: string;
  storeLogo?: string;
  storeCode?: string;

  amount: number;
  currency: string;
  direction: FinancialDirection;

  unitPrice?: number;
  shippingCost?: number;
  commission?: number;
  gatewayFee?: number;
  refundedAmount?: number;
  balanceAfter?: number;
  userRole?: string;
  merchantAmount?: number;
  escrowStatus?: string;

  payoutMethod?: string;
  adminNotes?: string;
  stripeTransferId?: string;
  processedAt?: Date;

  paymentId?: string;
  walletTxId?: string;
  transactionNumber?: string;
  financialImpact?: FinancialImpact;

  eventType: string;
  eventTypeAr: string;
  eventTypeEn: string;

  status: string;
  description?: string;
  metadata?: Record<string, unknown>;

  createdAt: Date;
  updatedAt?: Date;
}

export interface FinancialFeedResponseDto {
  data: UnifiedFinancialEventDto[];
  total: number;
  hasMore: boolean;
  nextCursor?: string;
}
