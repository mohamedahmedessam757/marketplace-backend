-- Phase 6: Syncing Reviews Table Schema
-- This script renames 'user_id' to 'customer_id' in the 'reviews' table
-- to align the physical database with the Prisma schema mapping.

DO $$ 
BEGIN
    -- Check if the old column name exists before attempting to rename
    IF EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name='reviews' AND column_name='user_id'
    ) THEN
        ALTER TABLE "reviews" RENAME COLUMN "user_id" TO "customer_id";
        RAISE NOTICE 'Column user_id renamed to customer_id successfully.';
    ELSE
        RAISE NOTICE 'Column user_id does not exist in table reviews. Skipping rename.';
    END IF;
END $$;
