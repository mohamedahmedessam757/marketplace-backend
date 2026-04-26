-- 1. Update ShipmentStatus Enum
-- Note: Execute these one by one if your SQL editor doesn't support multi-statement ALTER TYPE
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'RETURN_LABEL_ISSUED';
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'RETURN_STARTED';
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'RECEIVED_FROM_CUSTOMER';
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'DELIVERED_TO_VENDOR';
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'EXCHANGE_COMPLETED';
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'IN_TRANSIT_TO_CUSTOMER';
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'RETURN_COMPLETED_TO_CUSTOMER';

-- 2. Ensure Order table has Warranty columns (Idempotent)
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='warranty_active_at') THEN
        ALTER TABLE orders ADD COLUMN warranty_active_at TIMESTAMP WITH TIME ZONE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='warranty_end_at') THEN
        ALTER TABLE orders ADD COLUMN warranty_end_at TIMESTAMP WITH TIME ZONE;
    END IF;
END $$;

-- 3. Verify OrderStatus Enum for Warranty states (if needed)
-- OrderStatus already contains WARRANTY_ACTIVE and WARRANTY_EXPIRED in schema.prisma
-- Let's ensure they are in the DB as well
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'WARRANTY_ACTIVE';
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'WARRANTY_EXPIRED';
