-- Migration: Add Admin Signature fields to VerificationDocument
ALTER TABLE "verification_documents" 
ADD COLUMN "admin_signature_name" TEXT,
ADD COLUMN "admin_signature_image" TEXT,
ADD COLUMN "admin_signature_type" TEXT DEFAULT 'TYPED',
ADD COLUMN "admin_signature_text" TEXT;

-- Update existing audit logs or prepare for new ones (already handled by application logic)
