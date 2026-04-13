-- Migration: Add Payout and Stripe fields to Users and update WithdrawalRequests
-- Date: 2026-04-12

-- 1. Update Users Table for Payouts
ALTER TABLE IF EXISTS "users" 
ADD COLUMN IF NOT EXISTS "bank_name" TEXT,
ADD COLUMN IF NOT EXISTS "bank_account_holder" TEXT,
ADD COLUMN IF NOT EXISTS "bank_iban" TEXT,
ADD COLUMN IF NOT EXISTS "bank_swift" TEXT,
ADD COLUMN IF NOT EXISTS "bank_details_verified" BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS "stripe_account_id" TEXT,
ADD COLUMN IF NOT EXISTS "stripe_onboarded" BOOLEAN DEFAULT false;

-- 2. Update Withdrawal Requests Table
-- First, make store_id nullable
ALTER TABLE IF EXISTS "withdrawal_requests" ALTER COLUMN "store_id" DROP NOT NULL;

-- Add user_id and role
ALTER TABLE IF EXISTS "withdrawal_requests" 
ADD COLUMN IF NOT EXISTS "user_id" UUID REFERENCES "users"(id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS "role" TEXT DEFAULT 'VENDOR'; -- 'VENDOR' or 'CUSTOMER'

-- Add index for user_id
CREATE INDEX IF NOT EXISTS "withdrawal_requests_user_id_idx" ON "withdrawal_requests"("user_id");

COMMENT ON COLUMN "withdrawal_requests"."role" IS 'Role of the person requesting withdrawal: VENDOR or CUSTOMER';
