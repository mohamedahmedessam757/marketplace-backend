-- 2026 Warranty System Fix & Migration
-- This script ensures columns exist and migrates existing completed/delivered orders to the warranty state.

-- 1. Ensure Columns exist (Idempotent)
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='warranty_active_at') THEN
        ALTER TABLE orders ADD COLUMN warranty_active_at TIMESTAMP WITH TIME ZONE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='warranty_end_at') THEN
        ALTER TABLE orders ADD COLUMN warranty_end_at TIMESTAMP WITH TIME ZONE;
    END IF;
END $$;

-- 2. Data Migration for existing orders
-- Logic: Move COMPLETED/DELIVERED orders with active warranties to WARRANTY_ACTIVE state
WITH OrderWarrantyCalc AS (
    SELECT 
        o.id as order_id,
        o.updated_at as status_changed_at,
        MAX(
            CASE 
                WHEN off.warranty_duration ILIKE '%day%' THEN o.updated_at + (substring(off.warranty_duration from '\d+')::int * interval '1 day')
                WHEN off.warranty_duration ILIKE '%month%' THEN o.updated_at + (substring(off.warranty_duration from '\d+')::int * interval '1 month')
                WHEN off.warranty_duration ILIKE '%year%' THEN o.updated_at + (substring(off.warranty_duration from '\d+')::int * interval '1 year')
                ELSE o.updated_at + interval '15 days'
            END
        ) as calculated_warranty_end
    FROM orders o
    JOIN offers off ON o.id = off.order_id
    WHERE o.status IN ('COMPLETED', 'DELIVERED')
      AND off.status IN ('accepted', 'ACCEPTED')
      AND off.has_warranty = true
    GROUP BY o.id, o.updated_at
)
UPDATE orders
SET 
    status = 'WARRANTY_ACTIVE',
    warranty_active_at = owc.status_changed_at,
    warranty_end_at = owc.calculated_warranty_end,
    updated_at = NOW()
FROM OrderWarrantyCalc owc
WHERE orders.id = owc.order_id
  AND owc.calculated_warranty_end > NOW();

-- 3. Mark orders where warranty already expired as WARRANTY_EXPIRED
WITH ExpiredWarrantyCalc AS (
    SELECT 
        o.id as order_id,
        o.updated_at as status_changed_at,
        MAX(
            CASE 
                WHEN off.warranty_duration ILIKE '%day%' THEN o.updated_at + (substring(off.warranty_duration from '\d+')::int * interval '1 day')
                WHEN off.warranty_duration ILIKE '%month%' THEN o.updated_at + (substring(off.warranty_duration from '\d+')::int * interval '1 month')
                WHEN off.warranty_duration ILIKE '%year%' THEN o.updated_at + (substring(off.warranty_duration from '\d+')::int * interval '1 year')
                ELSE o.updated_at + interval '15 days'
            END
        ) as calculated_warranty_end
    FROM orders o
    JOIN offers off ON o.id = off.order_id
    WHERE o.status IN ('COMPLETED', 'DELIVERED')
      AND off.status IN ('accepted', 'ACCEPTED')
      AND off.has_warranty = true
    GROUP BY o.id, o.updated_at
)
UPDATE orders
SET 
    status = 'WARRANTY_EXPIRED',
    warranty_active_at = ewc.status_changed_at,
    warranty_end_at = ewc.calculated_warranty_end,
    updated_at = NOW()
FROM ExpiredWarrantyCalc ewc
WHERE orders.id = ewc.order_id
  AND ewc.calculated_warranty_end <= NOW();
