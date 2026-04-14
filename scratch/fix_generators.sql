-- ====================================================================
-- FIX: Transition from COUNT-based numbers to SEQUENCES
-- Use this script in Supabase SQL Editor to fix ID collisions.
-- ====================================================================

-- 1. Create Sequence for Payment Transactions
-- Starting from 3 because current max is TXN-2604-00002
CREATE SEQUENCE IF NOT EXISTS payment_transaction_seq START WITH 3;

-- 2. Create Sequence for Invoices
-- Starting from 3 because current max is INV-2604-00002
CREATE SEQUENCE IF NOT EXISTS invoice_seq START WITH 3;

-- 3. Update generate_transaction_number function
CREATE OR REPLACE FUNCTION generate_transaction_number()
RETURNS TEXT AS $$
DECLARE
    prefix TEXT := 'TXN-';
    date_part TEXT := to_char(now(), 'YYMM');
    seq INT;
BEGIN
    -- Atomic sequence increment
    SELECT nextval('payment_transaction_seq') INTO seq;
    RETURN prefix || date_part || '-' || LPAD(seq::TEXT, 5, '0');
END;
$$ LANGUAGE plpgsql;

-- 4. Update generate_invoice_number function
CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TEXT AS $$
DECLARE
    prefix TEXT := 'INV-';
    date_part TEXT := to_char(now(), 'YYMM');
    seq INT;
BEGIN
    -- Atomic sequence increment
    SELECT nextval('invoice_seq') INTO seq;
    RETURN prefix || date_part || '-' || LPAD(seq::TEXT, 5, '0');
END;
$$ LANGUAGE plpgsql;
