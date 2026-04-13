-- Manual Migration for Merchant Withdrawal System
-- Phase 2: Database Structures

-- 1. Create Withdrawal Requests Table
CREATE TABLE IF NOT EXISTS "withdrawal_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "stripe_transfer_id" TEXT,
    "admin_notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "withdrawal_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "withdrawal_requests_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 2. Create Platform Settings Table
CREATE TABLE IF NOT EXISTS "platform_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "setting_key" TEXT NOT NULL,
    "setting_value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_settings_setting_key_key" UNIQUE ("setting_key")
);

-- 3. Create Indexes for Performance
CREATE INDEX IF NOT EXISTS "withdrawal_requests_store_id_idx" ON "withdrawal_requests"("store_id");
CREATE INDEX IF NOT EXISTS "withdrawal_requests_status_idx" ON "withdrawal_requests"("status");

-- 4. Insert Initial Withdrawal Limits (Optional/Defaults)
INSERT INTO "platform_settings" ("setting_key", "setting_value")
VALUES ('withdrawal_limits', '{"min": 50, "max": 10000}')
ON CONFLICT ("setting_key") DO NOTHING;
