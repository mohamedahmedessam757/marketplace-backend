-- Migration: Make sender_id nullable in order_chat_messages
-- Purpose: Allow system messages (admin join, block notifications) that have no human sender.
-- Run this manually in Supabase SQL Editor.

ALTER TABLE order_chat_messages
  ALTER COLUMN sender_id DROP NOT NULL;
