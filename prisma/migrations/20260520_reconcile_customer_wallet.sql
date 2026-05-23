-- Manual reconciliation: customer total_spent from payment aggregates
-- Run manually on Supabase for seed/test customers. Safe to re-run (idempotent UPDATE).
--
-- Formula (matches customer-wallet-metrics.util.ts):
--   users.total_spent = SUM(payment_transactions.total_amount)
--     for SUCCESS payments on orders NOT IN (CANCELLED, REFUNDED)

BEGIN;

WITH customer_purchases AS (
  SELECT
    pt.customer_id,
    COALESCE(SUM(pt.total_amount), 0)::numeric(14, 2) AS total_spent
  FROM payment_transactions pt
  INNER JOIN orders ord ON ord.id = pt.order_id
  WHERE pt.status = 'SUCCESS'
    AND ord.status NOT IN ('CANCELLED', 'REFUNDED')
  GROUP BY pt.customer_id
)
UPDATE users u
SET total_spent = cp.total_spent
FROM customer_purchases cp
WHERE u.id = cp.customer_id
  AND u.role = 'CUSTOMER'
  AND u.total_spent IS DISTINCT FROM cp.total_spent;

COMMIT;

-- Optional: inspect Mohamed_Essam after run
-- SELECT u.username, u.total_spent, u.customer_balance, u.loyalty_tier, u.loyalty_points
-- FROM users u
-- WHERE u.username ILIKE '%Mohamed_Essam%';
