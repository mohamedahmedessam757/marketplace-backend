-- Phase 4: Widers contact sync fields on users
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS widers_contact_id TEXT,
    ADD COLUMN IF NOT EXISTS whatsapp_opt_in BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS widers_synced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS users_widers_synced_at_idx ON users (widers_synced_at)
    WHERE widers_contact_id IS NULL AND phone IS NOT NULL;
