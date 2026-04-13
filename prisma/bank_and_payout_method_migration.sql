-- Migration: Add Bank Transfer Details & Payout Method Support
-- Date: 2026-04-11
-- Purpose: Enable dual-payout (Stripe Connect + Manual Bank Transfer) for merchants

-- 1. Add Bank Details columns to Stores table
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "bank_name" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "bank_account_holder" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "bank_iban" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "bank_swift" TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "bank_details_verified" BOOLEAN NOT NULL DEFAULT false;

-- 2. Add Payout Method column to Withdrawal Requests table
ALTER TABLE "withdrawal_requests" ADD COLUMN IF NOT EXISTS "payout_method" TEXT NOT NULL DEFAULT 'BANK_TRANSFER';
-- Values: 'STRIPE' | 'BANK_TRANSFER'
