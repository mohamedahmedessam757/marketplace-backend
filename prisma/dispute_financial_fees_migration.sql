-- ================================================================
-- Dispute/Return Financial Fee Enforcement Migration
-- Date: 2026-05-08
-- Purpose: Add fee breakdown columns to returns and disputes tables
--          for gateway fees, refund fees, shipping, and fraud penalties
-- ================================================================

-- ========================
-- RETURNS TABLE
-- ========================
ALTER TABLE returns ADD COLUMN IF NOT EXISTS gateway_fee_pct DECIMAL(5,2) DEFAULT 3.00;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS refund_fee_pct DECIMAL(5,2) DEFAULT 1.50;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS gateway_fee_amount DECIMAL(14,2) DEFAULT 0;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS refund_fee_amount DECIMAL(14,2) DEFAULT 0;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS shipping_roundtrip DECIMAL(14,2) DEFAULT 0;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS penalty_amount DECIMAL(14,2) DEFAULT 0;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS penalty_type TEXT;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS net_refund_amount DECIMAL(14,2) DEFAULT 0;

-- ========================
-- DISPUTES TABLE
-- ========================
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS gateway_fee_pct DECIMAL(5,2) DEFAULT 3.00;
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS refund_fee_pct DECIMAL(5,2) DEFAULT 1.50;
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS gateway_fee_amount DECIMAL(14,2) DEFAULT 0;
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS refund_fee_amount DECIMAL(14,2) DEFAULT 0;
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS shipping_roundtrip DECIMAL(14,2) DEFAULT 0;
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS penalty_amount DECIMAL(14,2) DEFAULT 0;
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS penalty_type TEXT;
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS net_refund_amount DECIMAL(14,2) DEFAULT 0;

-- ========================
-- REALTIME (Enable for new columns)
-- ========================
-- No additional RLS changes needed since these tables already have Realtime enabled
-- The new columns inherit existing policies automatically
