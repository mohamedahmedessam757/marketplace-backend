-- SQL Migration Script to add missing columns to the `orders` table
-- This script mirrors the Prisma schema changes and safely adds the optional columns.

ALTER TABLE "public"."orders" 
ADD COLUMN IF NOT EXISTS "request_type" TEXT,
ADD COLUMN IF NOT EXISTS "shipping_type" TEXT,
ADD COLUMN IF NOT EXISTS "vin_image" TEXT;

-- Verify the columns were added (Optional: You can run this SELECT to check)
-- SELECT column_name, data_type 
-- FROM information_schema.columns 
-- WHERE table_name = 'orders' AND column_name IN ('request_type', 'shipping_type', 'vin_image');
