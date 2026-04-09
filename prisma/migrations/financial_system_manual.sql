-- AlterTable "stores"
ALTER TABLE "stores" ADD COLUMN "pending_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN "frozen_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN "stripe_account_id" TEXT,
ADD COLUMN "stripe_onboarded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "payout_schedule" TEXT NOT NULL DEFAULT 'MANUAL';

-- AlterTable "users"
ALTER TABLE "users" ADD COLUMN "customer_balance" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable "payment_transactions"
ALTER TABLE "payment_transactions" ADD COLUMN "stripe_transfer_id" TEXT,
ADD COLUMN "gateway_fee" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN "refunded_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN "refunded_at" TIMESTAMPTZ,
ADD COLUMN "refund_reason" TEXT,
ADD COLUMN "escrow_status" TEXT NOT NULL DEFAULT 'HELD';

-- AlterTable "wallet_transactions"
ALTER TABLE "wallet_transactions" ADD COLUMN "transaction_type" TEXT NOT NULL DEFAULT 'payment',
ADD COLUMN "metadata" JSONB DEFAULT '{}',
ADD COLUMN "escrow_id" UUID;

-- CreateTable "escrow_transactions"
CREATE TABLE "escrow_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "merchant_amount" DECIMAL(14,2) NOT NULL,
    "commission_amount" DECIMAL(14,2) NOT NULL,
    "shipping_amount" DECIMAL(14,2) NOT NULL,
    "gateway_fee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "release_condition" TEXT,
    "released_at" TIMESTAMPTZ,
    "frozen_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escrow_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable "platform_wallet"
CREATE TABLE "platform_wallet" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "commission_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "fees_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_revenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_wallet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "escrow_transactions_order_id_idx" ON "escrow_transactions"("order_id");
CREATE INDEX "escrow_transactions_status_idx" ON "escrow_transactions"("status");
