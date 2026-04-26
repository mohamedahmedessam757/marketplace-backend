-- SQL Migration: Add Verdict Governance Fields to Returns & Disputes Tables
-- Purpose: Ensures both tables support final verdict tracking and governance lockdown.
-- Execution: Run this manually in your Supabase SQL Editor.

---------------------------------------------------------
-- 1. RETURNS TABLE ENHANCEMENTS
---------------------------------------------------------

-- Add verdict_issued_at column to returns
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='returns' AND column_name='verdict_issued_at') THEN
        ALTER TABLE "public"."returns" ADD COLUMN "verdict_issued_at" TIMESTAMPTZ;
    END IF;
END $$;

-- Add verdict_locked column to returns
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='returns' AND column_name='verdict_locked') THEN
        ALTER TABLE "public"."returns" ADD COLUMN "verdict_locked" BOOLEAN DEFAULT false;
    END IF;
END $$;

-- Add index for performance on returns
CREATE INDEX IF NOT EXISTS idx_returns_verdict_issued_at ON "public"."returns"("verdict_issued_at");

---------------------------------------------------------
-- 2. DISPUTES TABLE ENHANCEMENTS
---------------------------------------------------------

-- Add verdict_issued_at column to disputes
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='disputes' AND column_name='verdict_issued_at') THEN
        ALTER TABLE "public"."disputes" ADD COLUMN "verdict_issued_at" TIMESTAMPTZ;
    END IF;
END $$;

-- Add verdict_locked column to disputes
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='disputes' AND column_name='verdict_locked') THEN
        ALTER TABLE "public"."disputes" ADD COLUMN "verdict_locked" BOOLEAN DEFAULT false;
    END IF;
END $$;

-- Add index for performance on disputes
CREATE INDEX IF NOT EXISTS idx_disputes_verdict_issued_at ON "public"."disputes"("verdict_issued_at");

---------------------------------------------------------
-- 3. DATA CLEANUP (Optional)
---------------------------------------------------------

-- Update existing resolved cases to have a verdict timestamp if missing
UPDATE "public"."returns" SET "verdict_issued_at" = "updated_at" WHERE ("status" = 'RESOLVED' OR "status" = 'REFUNDED' OR "status" = 'CLOSED') AND "verdict_issued_at" IS NULL;
UPDATE "public"."disputes" SET "verdict_issued_at" = "updated_at" WHERE ("status" = 'RESOLVED' OR "status" = 'REFUNDED' OR "status" = 'CLOSED') AND "verdict_issued_at" IS NULL;
