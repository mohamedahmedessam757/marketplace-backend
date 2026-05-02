-- 2026 Stripe Integration Schema Update
-- Run this script in Supabase SQL Editor to add the missing columns

-- 1. Add stripe_customer_id to users table
ALTER TABLE "users" 
ADD COLUMN IF NOT EXISTS "stripe_customer_id" TEXT;

-- 2. Add stripe_payment_method_id to user_cards table
ALTER TABLE "user_cards" 
ADD COLUMN IF NOT EXISTS "stripe_payment_method_id" TEXT;

-- 3. Create index for performance on customer lookups
CREATE INDEX IF NOT EXISTS "users_stripe_customer_id_idx" ON "users"("stripe_customer_id");
