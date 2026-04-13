-- ==========================================================
-- Database Optimization: Audit Logs Search Index
-- ==========================================================
-- This script adds a B-Tree index on the timestamp column
-- and orderId/actorId to ensure that pagination and filtering
-- remain lightning-fast even with millions of records.
--
-- Running this in Supabase SQL Editor:
-- 1. Copy the code below.
-- 2. Go to Supabase > SQL Editor > New Query.
-- 3. Paste and Click "Run".

-- Index for fast sorting by newest logs
CREATE INDEX IF NOT EXISTS audit_logs_timestamp_idx 
ON public.audit_logs (timestamp DESC);

-- Composite index for entity-specific searches (orders, profile changes)
CREATE INDEX IF NOT EXISTS audit_logs_entity_search_idx 
ON public.audit_logs (entity, timestamp DESC);

-- Comments for documentation
COMMENT ON INDEX audit_logs_timestamp_idx IS 'Optimizes newest-first pagination for audit logs dashboard.';
