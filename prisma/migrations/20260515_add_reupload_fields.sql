-- Add re-verification fields to store_documents
ALTER TABLE "store_documents" 
ADD COLUMN IF NOT EXISTS "reupload_requested" BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS "reupload_message" TEXT,
ADD COLUMN IF NOT EXISTS "admin_signature" TEXT,
ADD COLUMN IF NOT EXISTS "admin_name" TEXT;

-- Update status constraint if any (Prisma usually handles this via application logic, but for clarity:)
-- COMMENT ON COLUMN "store_documents"."status" IS 'pending | approved | rejected | reupload_requested';
