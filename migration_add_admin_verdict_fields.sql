-- migration_add_admin_verdict_fields.sql
-- Goal: Add administrative governance and electronic signature fields to Dispute and ReturnRequest tables.
-- Execution: Manual execution in Supabase SQL Editor.

-- 1. Updates for 'disputes' table
ALTER TABLE disputes
  ADD COLUMN IF NOT EXISTS admin_approval VARCHAR(20),       -- 'APPROVED' | 'REJECTED'
  ADD COLUMN IF NOT EXISTS admin_approval_reason TEXT,       -- Detailed rationale for the decision
  ADD COLUMN IF NOT EXISTS admin_evidence JSONB DEFAULT '[]',-- Array of image URLs uploaded by admin
  ADD COLUMN IF NOT EXISTS admin_name VARCHAR(255),          -- Full name of the deciding officer
  ADD COLUMN IF NOT EXISTS admin_email VARCHAR(255),         -- Official email of the deciding officer
  ADD COLUMN IF NOT EXISTS admin_signature TEXT;             -- Electronic signature string/hash

-- 2. Updates for 'returns' table
ALTER TABLE returns
  ADD COLUMN IF NOT EXISTS admin_approval VARCHAR(20),       -- 'APPROVED' | 'REJECTED'
  ADD COLUMN IF NOT EXISTS admin_approval_reason TEXT,       -- Detailed rationale for the decision
  ADD COLUMN IF NOT EXISTS admin_evidence JSONB DEFAULT '[]',-- Array of image URLs uploaded by admin
  ADD COLUMN IF NOT EXISTS admin_name VARCHAR(255),          -- Full name of the deciding officer
  ADD COLUMN IF NOT EXISTS admin_email VARCHAR(255),         -- Official email of the deciding officer
  ADD COLUMN IF NOT EXISTS admin_signature TEXT;             -- Electronic signature string/hash

-- Adding comments for schema documentation
COMMENT ON COLUMN disputes.admin_approval IS 'The administrative final decision (APPROVED or REJECTED)';
COMMENT ON COLUMN returns.admin_approval IS 'The administrative final decision (APPROVED or REJECTED)';
