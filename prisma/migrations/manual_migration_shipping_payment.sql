-- Phase 1, Step 1.1: Database Schema Expansion
-- Adding columns to track shipping payment obligations and statuses for Returns and Disputes

-- 1. Update ReturnRequest Table (mapped to "returns")
ALTER TABLE "returns" 
ADD COLUMN IF NOT EXISTS "shipping_payee" TEXT,
ADD COLUMN IF NOT EXISTS "shipping_payment_status" TEXT DEFAULT 'PENDING',
ADD COLUMN IF NOT EXISTS "shipping_payment_method" TEXT,
ADD COLUMN IF NOT EXISTS "shipping_stripe_id" TEXT;

-- 2. Update Dispute Table (mapped to "disputes")
ALTER TABLE "disputes" 
ADD COLUMN IF NOT EXISTS "shipping_payee" TEXT,
ADD COLUMN IF NOT EXISTS "shipping_payment_status" TEXT DEFAULT 'PENDING',
ADD COLUMN IF NOT EXISTS "shipping_payment_method" TEXT,
ADD COLUMN IF NOT EXISTS "shipping_stripe_id" TEXT;

-- Verify columns (Postgres specific)
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'returns';
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'disputes';
