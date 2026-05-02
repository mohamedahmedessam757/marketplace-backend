-- 2026 Platform Governance: Chat Attachments Master Toggle
-- This script initializes the master toggle in the PlatformSettings table.

-- Ensure the row exists with a default 'true' (enabled) value
INSERT INTO public.platform_settings (setting_key, setting_value)
VALUES ('CHAT_ATTACHMENTS_ENABLED', 'true'::jsonb)
ON CONFLICT (setting_key) DO NOTHING;

-- Verification query
SELECT * FROM public.platform_settings WHERE setting_key = 'CHAT_ATTACHMENTS_ENABLED';
