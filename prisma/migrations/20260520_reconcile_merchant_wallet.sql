-- Manual reconciliation: merchant wallet counters (lifetime_earnings, completed_orders_count)
-- Run manually on Supabase for seed/test stores. Safe to re-run (idempotent UPDATE).
--
-- Formulas (matches merchant-wallet-metrics.util.ts):
--   lifetime_earnings      = SUM(unit_price) once per offer_id (dedupe duplicate SUCCESS payments)
--   completed_orders_count = COUNT(DISTINCT order_id) for paid orders with COMPLETED/DELIVERED or active escrow

BEGIN;

WITH merchant_gross AS (
  SELECT
    store_id,
    COALESCE(SUM(unit_price), 0)::numeric(14, 2) AS lifetime_earnings
  FROM (
    SELECT DISTINCT ON (o.store_id, pt.offer_id)
      o.store_id,
      pt.unit_price
    FROM payment_transactions pt
    INNER JOIN offers o ON o.id = pt.offer_id
    INNER JOIN orders ord ON ord.id = pt.order_id
    WHERE pt.status = 'SUCCESS'
      AND ord.status NOT IN ('CANCELLED', 'REFUNDED')
    ORDER BY o.store_id, pt.offer_id, pt.created_at DESC
  ) per_offer
  GROUP BY store_id
),
completed_orders AS (
  SELECT
    o.store_id,
    COUNT(DISTINCT pt.order_id)::int AS completed_orders_count
  FROM payment_transactions pt
  INNER JOIN offers o ON o.id = pt.offer_id
  INNER JOIN orders ord ON ord.id = pt.order_id
  WHERE pt.status = 'SUCCESS'
    AND ord.status NOT IN ('CANCELLED', 'REFUNDED')
    AND (
      ord.status IN ('COMPLETED', 'DELIVERED')
      OR EXISTS (
        SELECT 1
        FROM escrow_transactions et
        WHERE et.order_id = ord.id
          AND et.status IN ('HELD', 'RELEASED', 'FROZEN')
      )
    )
  GROUP BY o.store_id
),
reconciled AS (
  SELECT
    s.id AS store_id,
    COALESCE(mg.lifetime_earnings, 0) AS lifetime_earnings,
    COALESCE(co.completed_orders_count, 0) AS completed_orders_count
  FROM stores s
  LEFT JOIN merchant_gross mg ON mg.store_id = s.id
  LEFT JOIN completed_orders co ON co.store_id = s.id
)
UPDATE stores s
SET
  lifetime_earnings = r.lifetime_earnings,
  completed_orders_count = r.completed_orders_count
FROM reconciled r
WHERE s.id = r.store_id
  AND (
    s.lifetime_earnings IS DISTINCT FROM r.lifetime_earnings
    OR s.completed_orders_count IS DISTINCT FROM r.completed_orders_count
  );

COMMIT;

-- Optional: inspect Mohamed_Essam store after run
-- SELECT s.id, s.store_name, s.lifetime_earnings, s.completed_orders_count,
--        s.balance, s.pending_balance, s.frozen_balance
-- FROM stores s
-- JOIN users u ON u.id = s.owner_id
-- WHERE u.username ILIKE '%Mohamed_Essam%' OR s.store_name ILIKE '%Mohamed%';
