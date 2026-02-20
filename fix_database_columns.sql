-- SQL to fix missing user_type column in support_tickets table

-- 1. Check if column exists, if not add it
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'support_tickets' AND column_name = 'user_type') THEN
        ALTER TABLE support_tickets ADD COLUMN user_type TEXT NOT NULL DEFAULT 'customer';
    END IF;
END $$;

-- 2. Verify the column exists now
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'support_tickets' AND column_name = 'user_type';
