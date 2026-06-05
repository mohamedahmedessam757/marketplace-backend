-- Phase 5: user language preference for WhatsApp template selection
ALTER TABLE user_settings
    ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(8) NOT NULL DEFAULT 'ar';
