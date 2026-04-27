-- Optimize Audit Log filtering for new 2026 tracking types
-- This adds indexes for entity and action fields to ensure fast performance as the log grows.

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON "public"."audit_logs" ("entity");
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON "public"."audit_logs" ("action");

-- Optional: Ensure RLS is correctly configured for the audit_logs table if needed
-- (Assuming existing RLS allows Service Role/Admin access)
