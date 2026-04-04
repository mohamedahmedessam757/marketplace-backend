-- Migration: create_contract_acceptances
-- Adds a dedicated table to store merchant contract acceptances with full snapshots and inputted details.
-- PLEASE RUN THIS FILE IN YOUR SUPABASE SQL EDITOR

CREATE TABLE IF NOT EXISTS public.contract_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  contract_id UUID NOT NULL REFERENCES public.platform_contracts(id) ON DELETE RESTRICT,
  contract_version INT NOT NULL,
  
  -- The exact data the merchant filled out in the contract
  second_party_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  signature_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  
  -- Snapshots at the exact time of signing
  first_party_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_ar_snapshot TEXT NOT NULL,
  content_en_snapshot TEXT NOT NULL,
  
  -- Security Metadata
  ip_address VARCHAR(45),
  user_agent TEXT,
  
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Ensure a store only has one primary active acceptance per contract (optional, but good practice).
  CONSTRAINT uq_store_contract UNIQUE(store_id, contract_id)
);

-- Indexing for Admin quick lookups
CREATE INDEX idx_contract_acceptances_store ON public.contract_acceptances(store_id);
