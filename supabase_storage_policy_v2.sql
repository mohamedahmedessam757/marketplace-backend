-- Create the bucket if it doesn't exist
INSERT INTO storage.buckets (id, name, public) 
VALUES ('support-files', 'support-files', true)
ON CONFLICT (id) DO NOTHING;

-- DROP existing policies to avoid conflicts
DROP POLICY IF EXISTS "Allow authenticated uploads" ON storage.objects;
DROP POLICY IF EXISTS "Allow public viewing" ON storage.objects;
DROP POLICY IF EXISTS "Allow public uploads" ON storage.objects;

-- Policy to allow ANYONE (public) to upload to 'support-files'
-- This is necessary because the frontend uses the Supabase Anon key and is not authenticated via Supabase Auth
CREATE POLICY "Allow public uploads" 
ON storage.objects 
FOR INSERT 
TO public 
WITH CHECK (bucket_id = 'support-files');

-- Policy to allow anyone to view files in 'support-files'
CREATE POLICY "Allow public viewing" 
ON storage.objects 
FOR SELECT 
TO public 
USING (bucket_id = 'support-files');
