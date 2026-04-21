-- Migration: Admin Chat advanced actions Phase 1
-- Adds suspension details to User table.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "suspended_until" TIMESTAMPTZ;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "suspend_reason" TEXT;
