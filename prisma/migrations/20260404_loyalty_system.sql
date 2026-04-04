-- SQL Migration for 2026 Loyalty System
-- Purpose: Expand Users and Stores tables with loyalty and reputation metrics.

-- 1. Create Enum for Merchant Loyalty Tier
DO $$ BEGIN
    CREATE TYPE "StoreLoyaltyTier" AS ENUM ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Expand Stores Table
ALTER TABLE "stores" 
ADD COLUMN IF NOT EXISTS "loyalty_tier" "StoreLoyaltyTier" DEFAULT 'BRONZE',
ADD COLUMN IF NOT EXISTS "performance_score" DECIMAL(10,2) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS "lifetime_earnings" DECIMAL(14,2) DEFAULT 0.00;

-- 3. Expand Users Table
ALTER TABLE "users" 
ADD COLUMN IF NOT EXISTS "loyalty_points" INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS "referral_count" INTEGER DEFAULT 0;

-- 4. (Optional) Initialize existing records for safety
UPDATE "stores" SET "loyalty_tier" = 'BRONZE' WHERE "loyalty_tier" IS NULL;
UPDATE "users" SET "loyalty_points" = 0 WHERE "loyalty_points" IS NULL;
