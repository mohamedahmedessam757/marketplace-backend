-- Phase 4: Landing Page Support Integration (2026 Strategy)
-- Goal: Store guest contact information and track ticket source

-- 1. Add guest-related fields to order_chats (from Landing Page)
ALTER TABLE "order_chats" ADD COLUMN IF NOT EXISTS "guest_name" TEXT;
ALTER TABLE "order_chats" ADD COLUMN IF NOT EXISTS "guest_email" TEXT;
ALTER TABLE "order_chats" ADD COLUMN IF NOT EXISTS "guest_phone" TEXT;

-- 2. Add source field to distinguish between Landing Page and Dashboard requests
-- Options: LANDING, DASHBOARD
ALTER TABLE "order_chats" ADD COLUMN IF NOT EXISTS "source" TEXT DEFAULT 'DASHBOARD';

-- 3. Indexing for performance and lookup at scale
CREATE INDEX IF NOT EXISTS "idx_order_chats_source" ON "order_chats"("source");
CREATE INDEX IF NOT EXISTS "idx_order_chats_guest_email" ON "order_chats"("guest_email");
