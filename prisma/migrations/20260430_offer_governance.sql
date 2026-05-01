-- Phase 1: Market Governance & Offer Lifecycle Migration (2026)

-- 1. Update OrderStatus Enum (Using DO block for safety in Supabase)
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'order_status' AND e.enumlabel = 'COLLECTING_OFFERS') THEN
        ALTER TYPE "order_status" ADD VALUE 'COLLECTING_OFFERS';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'order_status' AND e.enumlabel = 'AWAITING_SELECTION') THEN
        ALTER TYPE "order_status" ADD VALUE 'AWAITING_SELECTION';
    END IF;
END $$;

-- 2. Add Governance Fields to 'orders' table
ALTER TABLE "orders" 
ADD COLUMN IF NOT EXISTS "reveal_offers_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "offers_stop_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "selection_deadline_at" TIMESTAMPTZ;

-- 3. Add Control Fields to 'offers' table
ALTER TABLE "offers" 
ADD COLUMN IF NOT EXISTS "can_edit_until" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "is_withdrawn" BOOLEAN DEFAULT FALSE;

-- 4. Add Performance Metrics to 'stores' table
ALTER TABLE "stores" 
ADD COLUMN IF NOT EXISTS "total_offers_sent" INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS "edit_count" INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS "withdrawal_count" INTEGER DEFAULT 0;

-- 5. Create Index for reveal timing to optimize cleanup jobs
CREATE INDEX IF NOT EXISTS "idx_orders_reveal_offers_at" ON "orders" ("reveal_offers_at") WHERE status = 'COLLECTING_OFFERS';
CREATE INDEX IF NOT EXISTS "idx_orders_selection_deadline_at" ON "orders" ("selection_deadline_at") WHERE status = 'AWAITING_SELECTION';

COMMENT ON COLUMN "offers"."can_edit_until" IS 'The 15-minute window for merchants to modify their offer';
COMMENT ON COLUMN "stores"."total_offers_sent" IS 'Total offers submitted by merchant for violation rate calculation';
