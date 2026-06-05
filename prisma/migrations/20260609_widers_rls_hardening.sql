-- Widers integration: deny-by-default RLS on backend-only tables.
-- NestJS uses service role (bypasses RLS). Block direct anon/authenticated Supabase client access.

ALTER TABLE IF EXISTS public.otp_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.whatsapp_message_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.widers_webhook_events ENABLE ROW LEVEL SECURITY;

-- No policies = deny all for anon/authenticated roles (service_role bypasses RLS).

COMMENT ON TABLE public.otp_challenges IS 'Backend-only OTP store; access via NestJS Prisma only.';
COMMENT ON TABLE public.whatsapp_message_logs IS 'Backend-only WhatsApp delivery logs; no direct client access.';
COMMENT ON TABLE public.widers_webhook_events IS 'Backend-only webhook idempotency; no direct client access.';
