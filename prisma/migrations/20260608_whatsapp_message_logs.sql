-- Phase 6: WhatsApp message logs + Widers webhook idempotency

DO $$ BEGIN
    CREATE TYPE whatsapp_message_direction AS ENUM ('OUTBOUND', 'INBOUND');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE whatsapp_delivery_status AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'UNKNOWN');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS whatsapp_message_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_message_id TEXT UNIQUE,
    direction whatsapp_message_direction NOT NULL DEFAULT 'OUTBOUND',
    phone TEXT,
    template_name TEXT,
    template_language VARCHAR(8),
    delivery_status whatsapp_delivery_status NOT NULL DEFAULT 'QUEUED',
    recipient_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    notification_id UUID,
    error_code TEXT,
    error_message TEXT,
    payload JSONB NOT NULL DEFAULT '{}',
    metadata JSONB NOT NULL DEFAULT '{}',
    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS whatsapp_message_logs_phone_idx ON whatsapp_message_logs (phone);
CREATE INDEX IF NOT EXISTS whatsapp_message_logs_delivery_status_idx ON whatsapp_message_logs (delivery_status);
CREATE INDEX IF NOT EXISTS whatsapp_message_logs_recipient_user_id_idx ON whatsapp_message_logs (recipient_user_id);
CREATE INDEX IF NOT EXISTS whatsapp_message_logs_template_name_idx ON whatsapp_message_logs (template_name);
CREATE INDEX IF NOT EXISTS whatsapp_message_logs_created_at_idx ON whatsapp_message_logs (created_at);

CREATE TABLE IF NOT EXISTS widers_webhook_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PROCESSING',
    payload JSONB NOT NULL DEFAULT '{}',
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS widers_webhook_events_event_type_idx ON widers_webhook_events (event_type);
CREATE INDEX IF NOT EXISTS widers_webhook_events_status_idx ON widers_webhook_events (status);
