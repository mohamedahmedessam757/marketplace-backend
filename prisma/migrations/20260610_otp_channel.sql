-- OTP delivery channel: email (Resend) or whatsapp (Widers)
ALTER TABLE otp_challenges
    ADD COLUMN IF NOT EXISTS channel VARCHAR(16) NOT NULL DEFAULT 'whatsapp';

ALTER TABLE otp_challenges
    ALTER COLUMN phone DROP NOT NULL;

DROP INDEX IF EXISTS otp_challenges_phone_purpose_idx;
DROP INDEX IF EXISTS otp_challenges_email_purpose_idx;

CREATE INDEX IF NOT EXISTS otp_challenges_phone_channel_purpose_idx
    ON otp_challenges (phone, purpose, channel)
    WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS otp_challenges_email_channel_purpose_idx
    ON otp_challenges (email, purpose, channel)
    WHERE email IS NOT NULL;
