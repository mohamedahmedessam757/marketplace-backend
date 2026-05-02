ALTER TABLE "order_chats" ADD COLUMN IF NOT EXISTS "is_attachments_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "returns" ADD COLUMN IF NOT EXISTS "is_attachments_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "disputes" ADD COLUMN IF NOT EXISTS "is_attachments_enabled" BOOLEAN NOT NULL DEFAULT true;
