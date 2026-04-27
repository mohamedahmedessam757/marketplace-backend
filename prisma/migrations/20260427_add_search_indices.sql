-- ==========================================
-- ADMIN SEARCH PERFORMANCE INDICES (2026)
-- ==========================================
-- This script optimizes the real-time search for Users and Stores.
-- Execute this in the Supabase SQL Editor.

-- 1. Enable pg_trgm extension for fuzzy string matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Index on User Name (GIN Index for fast 'contains' queries)
CREATE INDEX IF NOT EXISTS idx_users_name_trgm ON users USING gin (name gin_trgm_ops);

-- 3. Index on User Email (GIN Index for fast 'contains' queries)
CREATE INDEX IF NOT EXISTS idx_users_email_trgm ON users USING gin (email gin_trgm_ops);

-- 4. Index on Store Name
CREATE INDEX IF NOT EXISTS idx_stores_name_trgm ON stores USING gin (name gin_trgm_ops);

-- 5. Standard B-Tree index for exact ID matches (Prisma usually adds this, but safe to ensure)
CREATE INDEX IF NOT EXISTS idx_users_id_exact ON users (id);
CREATE INDEX IF NOT EXISTS idx_stores_owner_id ON stores (owner_id);

-- ==========================================
-- VERIFICATION QUERY
-- ==========================================
-- EXPLAIN ANALYZE SELECT * FROM users WHERE name ILIKE '%test%';
