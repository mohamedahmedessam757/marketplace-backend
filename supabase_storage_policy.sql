-- Create the bucket if it doesn't exist
INSERT INTO storage.buckets (id, name, public) 
VALUES ('support-files', 'support-files', true)
ON CONFLICT (id) DO NOTHING;

-- Policy to allow anyone (authenticated) to upload to 'support-files'
CREATE POLICY "Allow authenticated uploads" 
ON storage.objects 
FOR INSERT 
TO authenticated 
WITH CHECK (bucket_id = 'support-files');

-- Policy to allow anyone to view files in 'support-files'
CREATE POLICY "Allow public viewing" 
ON storage.objects 
FOR SELECT 
TO public 
USING (bucket_id = 'support-files');

-- Policy to allow users to update their own files (optional, but good for retries)
CREATE POLICY "Allow users to update their own files" 
ON storage.objects 
FOR UPDATE 
TO authenticated 
USING (bucket_id = 'support-files' AND auth.uid() = owner);
