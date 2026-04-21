-- Create Rating Impact Rules Table
CREATE TABLE IF NOT EXISTS public.rating_impact_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    min_rating DECIMAL(3,2) NOT NULL,
    max_rating DECIMAL(3,2) NOT NULL,
    action_type TEXT NOT NULL, -- 'SUSPEND', 'WARNING', 'FEATURED', 'NONE'
    action_label_ar TEXT NOT NULL,
    action_label_en TEXT NOT NULL,
    suspend_duration_days INT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_rating_impact_min_max ON public.rating_impact_rules (min_rating, max_rating);

-- Insert Default Rules
INSERT INTO public.rating_impact_rules (min_rating, max_rating, action_type, action_label_ar, action_label_en, suspend_duration_days)
VALUES 
(0.00, 1.99, 'SUSPEND', 'إيقاف مؤقت للمتجر', 'Temporary Store Suspension', 7),
(2.00, 3.00, 'WARNING', 'تحذير التاجر', 'Merchant Warning', NULL),
(4.01, 5.00, 'FEATURED', 'تاجر مميز', 'Featured Merchant', NULL);
