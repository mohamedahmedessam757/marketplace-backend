-- 2026 Logistics & Engine Shipping Migration
-- This script fixes the "column offers.cylinders does not exist" error and updates logistics configuration.

-- 1. Add missing columns to 'offers' table
-- We use 'IF NOT EXISTS' for safety, though Postgres 9.6+ supports it.
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='cylinders') THEN
        ALTER TABLE "offers" ADD COLUMN "cylinders" INTEGER;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='part_type') THEN
        ALTER TABLE "offers" ADD COLUMN "part_type" TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='offer_image') THEN
        ALTER TABLE "offers" ADD COLUMN "offer_image" TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='offer_number') THEN
        ALTER TABLE "offers" ADD COLUMN "offer_number" TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='order_part_id') THEN
        ALTER TABLE "offers" ADD COLUMN "order_part_id" UUID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='warranty_duration') THEN
        ALTER TABLE "offers" ADD COLUMN "warranty_duration" TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='can_edit_until') THEN
        ALTER TABLE "offers" ADD COLUMN "can_edit_until" TIMESTAMPTZ;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='is_withdrawn') THEN
        ALTER TABLE "offers" ADD COLUMN "is_withdrawn" BOOLEAN DEFAULT false;
    END IF;
END $$;

-- 2. Add Unique constraint for offer_number
-- Using a DO block to avoid error if constraint already exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offers_offer_number_key') THEN
        ALTER TABLE "offers" ADD CONSTRAINT "offers_offer_number_key" UNIQUE ("offer_number");
    END IF;
END $$;

-- 3. Add Foreign Key for order_part_id
-- We assume 'order_parts' table exists as per 2026 schema.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offers_order_part_id_fkey') THEN
        ALTER TABLE "offers" ADD CONSTRAINT "offers_order_part_id_fkey" 
        FOREIGN KEY ("order_part_id") REFERENCES "order_parts"("id") ON DELETE SET NULL;
    END IF;
END $$;

-- 4. Create Indices for performance
CREATE INDEX IF NOT EXISTS "idx_offers_order_part" ON "offers"("order_part_id");
CREATE INDEX IF NOT EXISTS "idx_offers_cylinders" ON "offers"("cylinders");

-- 5. Data Update: Enable cylinders for Engine shipping by default in system_config
-- This update targets the 'platform_settings' table where key is 'system_config'.
UPDATE "platform_settings" 
SET "setting_value" = jsonb_set(
    "setting_value", 
    '{logistics,shipmentTypes}', 
    (
        SELECT jsonb_agg(
            CASE 
                WHEN x->>'id' = 'engine' THEN x || '{"hasCylinders": true, "cylinderRates": [{"cylinders": 4, "price": 450}, {"cylinders": 6, "price": 650}, {"cylinders": 8, "price": 850}, {"cylinders": 10, "price": 1050}, {"cylinders": 12, "price": 1250}]}'::jsonb
                ELSE x 
            END
        )
        FROM jsonb_array_elements("setting_value"->'logistics'->'shipmentTypes') x
    )
)
WHERE "setting_key" = 'system_config';
