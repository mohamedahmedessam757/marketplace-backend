-- Migration: Update disputes_status_check constraint (2026-04-25)
-- Issue: CHECK constraint only allows OPEN, CLOSED, RESOLVED, UNDER_REVIEW
-- Fix: Add all required lifecycle statuses

-- Step 1: Drop old constraint
ALTER TABLE disputes DROP CONSTRAINT IF EXISTS disputes_status_check;

-- Step 2: Add new comprehensive constraint
ALTER TABLE disputes ADD CONSTRAINT disputes_status_check 
CHECK (status IN (
  'OPEN', 
  'CLOSED', 
  'RESOLVED', 
  'UNDER_REVIEW', 
  'REFUNDED',
  'PENDING',
  'AWAITING_ADMIN',
  'AWAITING_MERCHANT',
  'ESCALATED',
  'APPROVED',
  'REJECTED',
  'MERCHANT_RESPONDED'
));
