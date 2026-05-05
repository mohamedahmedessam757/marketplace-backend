-- Fix for missing store_loyalty_tier type in PostgreSQL
-- This script ensures the enum type matches Prisma's @@map("store_loyalty_tier")

DO $$ BEGIN
    -- 1. Create the correctly named type if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'store_loyalty_tier') THEN
        CREATE TYPE "store_loyalty_tier" AS ENUM ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM');
    END IF;
END $$;

-- 2. Ensure the stores table uses the correct type for the loyalty_tier column
-- We use a temporary column to transition if needed, or just alter if possible.
-- If the column already exists but has a different type, we need to cast it.

ALTER TABLE "stores" 
ALTER COLUMN "loyalty_tier" TYPE "store_loyalty_tier" 
USING ("loyalty_tier"::text::"store_loyalty_tier");

-- 3. Set default again just in case
ALTER TABLE "stores" ALTER COLUMN "loyalty_tier" SET DEFAULT 'BRONZE';
