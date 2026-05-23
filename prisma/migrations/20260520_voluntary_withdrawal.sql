-- Manual migration: run in Supabase SQL Editor if local connection fails
-- Voluntary withdrawal type on offers

ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS withdrawal_type TEXT NULL;

COMMENT ON COLUMN offers.withdrawal_type IS
  'null | voluntary | violation — withdrawal classification';

CREATE INDEX IF NOT EXISTS idx_offers_withdrawal_type
  ON offers (withdrawal_type)
  WHERE withdrawal_type IS NOT NULL;

-- Backfill legacy withdrawn offers as violation-type
UPDATE offers
SET withdrawal_type = 'violation'
WHERE is_withdrawn = true
  AND withdrawal_type IS NULL;
