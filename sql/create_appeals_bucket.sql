-- Phase 1.1: Create Appeals Storage Bucket
-- Run this in the Supabase SQL Editor

-- 1. Create the 'appeals' bucket if it doesn't exist
INSERT INTO storage.buckets (id, name, public)
VALUES ('appeals', 'appeals', true)
ON CONFLICT (id) DO NOTHING;

-- 2. Enable public read access for the 'appeals' bucket
-- This allows getPublicUrl() to work correctly for guests and users
CREATE POLICY "Public Read Access for Appeals"
ON storage.objects FOR SELECT
USING ( bucket_id = 'appeals' );

-- 3. (Optional) Allow authenticated uploads if you ever decide to upload directly from frontend
-- For now, the backend uses SERVICE_ROLE which bypasses these policies.
-- CREATE POLICY "Authenticated Uploads for Appeals"
-- ON storage.objects FOR INSERT
-- TO authenticated
-- WITH CHECK ( bucket_id = 'appeals' );
