-- Phase 1: Chat Data Model Enhancement (2026 Strategy) - CORRECTED
-- Goal: Suppport smart categorization and precise message alignment

-- 1. Add category to order_chats to support smart badges and filtering
ALTER TABLE "order_chats" ADD COLUMN IF NOT EXISTS "category" TEXT DEFAULT 'OTHER';

-- 2. Add sender_role to order_chat_messages for precise UI alignment
ALTER TABLE "order_chat_messages" ADD COLUMN IF NOT EXISTS "sender_role" TEXT;

-- 3. Indexing for performance at scale
CREATE INDEX IF NOT EXISTS "idx_order_chats_category" ON "order_chats"("category");
CREATE INDEX IF NOT EXISTS "idx_order_chat_messages_sender_role" ON "order_chat_messages"("sender_role");
