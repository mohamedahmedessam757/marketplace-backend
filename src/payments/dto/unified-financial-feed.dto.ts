/**
 * Unified Financial Feed DTO — 2026 Standard
 * Normalizes data from Payment, Wallet, Escrow, and Withdrawal tables
 * into a single structure for the Admin Financial Center.
 *
 * No @nestjs/swagger dependency required — uses plain TypeScript.
 */

export enum FinancialEventSource {
  PAYMENT = 'PAYMENT',
  WALLET = 'WALLET',
  ESCROW = 'ESCROW',
  WITHDRAWAL = 'WITHDRAWAL',
}

export enum FinancialDirection {
  CREDIT = 'CREDIT',   // Money coming in (to platform or user)
  DEBIT = 'DEBIT',     // Money going out
  HOLD = 'HOLD',       // Escrow hold
  RELEASE = 'RELEASE', // Escrow release
  FREEZE = 'FREEZE',   // Dispute freeze
}

export interface UnifiedFinancialEventDto {
  id: string;
  source: FinancialEventSource;

  // Order Metadata
  orderId?: string;
  orderNumber?: string;

  // Customer Metadata
  customerId?: string;
  customerName?: string;
  customerCode?: string;
  customerAvatar?: string;

  // Merchant / Store Metadata
  storeId?: string;
  storeName?: string;
  storeLogo?: string;
  storeCode?: string;

  // Financial Data
  amount: number;
  currency: string;
  direction: FinancialDirection;

  // Event Classification
  eventType: string;     // e.g. 'PAYMENT_SUCCESS', 'ESCROW_HELD'
  eventTypeAr: string;   // Arabic label
  eventTypeEn: string;   // English label

  // Status
  status: string;

  // Description & Metadata
  description?: string;
  metadata?: Record<string, any>;

  // Timestamps
  createdAt: Date;
  updatedAt?: Date;
}

export interface FinancialFeedResponseDto {
  data: UnifiedFinancialEventDto[];
  total: number;
  hasMore: boolean;
}
