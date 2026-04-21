-- Migration to allow Admin-to-Vendor direct support chats
-- This script makes the customer_id column optional (NULLable)
-- Run this in your Supabase SQL Editor

ALTER TABLE "order_chats" ALTER COLUMN "customer_id" DROP NOT NULL;

-- Log the migration for record
INSERT INTO "audit_logs" (action, entity, actor_type, reason, metadata)
VALUES ('DB_MIGRATION', 'OrderChat', 'SYSTEM', 'Making customer_id optional for support chats', '{"column": "customer_id", "action": "DROP NOT NULL"}');
