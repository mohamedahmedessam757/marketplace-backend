-- SQL Migration to fix existing approved documents based on their actual approval date
-- This will set the expiry date to 365 days from the last update (approval) date
-- ensuring the 1-year duration starts correctly for each merchant independently.

UPDATE store_documents
SET expires_at = updated_at + INTERVAL '365 days'
WHERE status = 'approved' 
  AND expires_at IS NULL;

-- Verification query to see the dynamic dates
SELECT 
    store_id, 
    doc_type, 
    updated_at as approval_date, 
    expires_at as expiry_date,
    (expires_at::date - CURRENT_DATE) as days_remaining
FROM store_documents 
WHERE status = 'approved';
