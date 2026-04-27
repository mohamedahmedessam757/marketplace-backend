-- Phase 3: Data Consistency & Payee Logic Fix
-- This script corrects records misassigned due to case-sensitivity bugs ('Merchant' vs 'MERCHANT')

-- 1. Fix inconsistencies in the 'returns' table
UPDATE "returns"
SET "shipping_payee" = 'MERCHANT'
WHERE "fault_party" ILIKE 'merchant' 
   OR "fault_party" ILIKE 'store' 
   OR "fault_party" ILIKE 'vendor';

UPDATE "returns"
SET "shipping_payee" = 'CUSTOMER'
WHERE "fault_party" ILIKE 'customer';

-- 2. Fix inconsistencies in the 'disputes' table
UPDATE "disputes"
SET "shipping_payee" = 'MERCHANT'
WHERE "fault_party" ILIKE 'merchant' 
   OR "fault_party" ILIKE 'store' 
   OR "fault_party" ILIKE 'vendor';

UPDATE "disputes"
SET "shipping_payee" = 'CUSTOMER'
WHERE "fault_party" ILIKE 'customer';

-- 3. Ensure PENDING status for unpaid obligations
UPDATE "returns"
SET "shipping_payment_status" = 'PENDING'
WHERE "shipping_payee" IS NOT NULL 
  AND "shipping_refund" > 0 
  AND "shipping_payment_status" IS NULL;

UPDATE "disputes"
SET "shipping_payment_status" = 'PENDING'
WHERE "shipping_payee" IS NOT NULL 
  AND "shipping_refund" > 0 
  AND "shipping_payment_status" IS NULL;

-- Verification Query
-- SELECT id, fault_party, shipping_payee, shipping_payment_status FROM "returns" WHERE shipping_payee IS NOT NULL;
-- SELECT id, fault_party, shipping_payee, shipping_payment_status FROM "disputes" WHERE shipping_payee IS NOT NULL;
