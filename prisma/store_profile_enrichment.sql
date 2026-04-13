-- Migration: Add Admin Notes and Suspension details to Stores
-- This adds 'admin_notes' for internal private notes and 'suspended_until' for temporary bans automation.

ALTER TABLE stores ADD COLUMN IF NOT EXISTS admin_notes TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ;

COMMENT ON COLUMN stores.admin_notes IS 'Private internal notes for admin use regarding the store';
COMMENT ON COLUMN stores.suspended_until IS 'Expiry date for temporary suspension/ban. Automatic lift should occur after this.';
