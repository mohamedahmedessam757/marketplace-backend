-- 2026 Payment Optimization: Indexes for Stripe & Real-time lookups

-- 1. Index on stripePaymentId for fast webhook fulfillment
CREATE INDEX IF NOT EXISTS "payment_transaction_stripe_payment_id_idx" 
ON "payment_transactions"("stripe_payment_id");

-- 2. Index on offerId for fast status checks (if not already unique/indexed)
CREATE INDEX IF NOT EXISTS "payment_transaction_offer_id_idx" 
ON "payment_transactions"("offer_id");

-- 3. Index on customerId + status for dashboard performance
CREATE INDEX IF NOT EXISTS "payment_transaction_customer_status_idx" 
ON "payment_transactions"("customer_id", "status");
