-- WhatsApp OTP challenges (Phase 2 Widers integration)
CREATE TABLE IF NOT EXISTS otp_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone TEXT NOT NULL,
    email TEXT,
    purpose VARCHAR(32) NOT NULL,
    role VARCHAR(16),
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    verified_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS otp_challenges_phone_purpose_idx ON otp_challenges (phone, purpose);
CREATE INDEX IF NOT EXISTS otp_challenges_email_purpose_idx ON otp_challenges (email, purpose);
