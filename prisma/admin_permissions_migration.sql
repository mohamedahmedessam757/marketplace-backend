-- ============================================================
-- Admin Permissions System Migration
-- نظام إدارة صلاحيات المسؤولين
-- 
-- !! تعليمات التشغيل !!
-- 1. افتح Supabase Dashboard
-- 2. اذهب إلى SQL Editor
-- 3. الصق هذا الكود كاملاً واضغط RUN
-- ============================================================

-- Step 1: Create admin_permissions table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.admin_permissions (
    id              UUID        NOT NULL DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL,
    permissions     JSONB       NOT NULL DEFAULT '{}',
    support_ticket_categories   TEXT[]  NOT NULL DEFAULT '{}',
    blurred_sections            TEXT[]  NOT NULL DEFAULT '{}',
    is_active       BOOLEAN     NOT NULL DEFAULT true,
    created_by      UUID,
    updated_by      UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT admin_permissions_pkey PRIMARY KEY (id),
    CONSTRAINT admin_permissions_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES public.users(id) ON DELETE CASCADE,
    CONSTRAINT admin_permissions_created_by_fkey FOREIGN KEY (created_by)
        REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT admin_permissions_updated_by_fkey FOREIGN KEY (updated_by)
        REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT admin_permissions_user_id_key UNIQUE (user_id)
);

-- Step 2: Create indexes for performance
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_admin_permissions_user_id
    ON public.admin_permissions(user_id);

CREATE INDEX IF NOT EXISTS idx_admin_permissions_is_active
    ON public.admin_permissions(is_active);

CREATE INDEX IF NOT EXISTS idx_admin_permissions_created_at
    ON public.admin_permissions(created_at DESC);

-- Step 3: Enable RLS (Row Level Security)
-- ============================================================
ALTER TABLE public.admin_permissions ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any (safe re-run)
DROP POLICY IF EXISTS "super_admin_full_access" ON public.admin_permissions;
DROP POLICY IF EXISTS "admin_read_own" ON public.admin_permissions;

-- Super Admin: Full CRUD access
CREATE POLICY "super_admin_full_access" ON public.admin_permissions
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE users.id::text = auth.uid()::text
            AND users.role = 'SUPER_ADMIN'
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE users.id::text = auth.uid()::text
            AND users.role = 'SUPER_ADMIN'
        )
    );

-- Admin/Support: Read their own permissions only
CREATE POLICY "admin_read_own" ON public.admin_permissions
    FOR SELECT
    USING (
        user_id::text = auth.uid()::text
        OR EXISTS (
            SELECT 1 FROM public.users
            WHERE users.id::text = auth.uid()::text
            AND users.role = 'SUPER_ADMIN'
        )
    );

-- Step 4: Create updated_at trigger
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_admin_permissions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admin_permissions_updated_at ON public.admin_permissions;
CREATE TRIGGER trg_admin_permissions_updated_at
    BEFORE UPDATE ON public.admin_permissions
    FOR EACH ROW
    EXECUTE FUNCTION public.update_admin_permissions_updated_at();

-- Step 5: Enable Realtime for this table
-- ============================================================
DO $$
BEGIN
    -- Add table to realtime publication if not already there
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
        AND tablename = 'admin_permissions'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.admin_permissions;
    END IF;
EXCEPTION
    WHEN others THEN
        RAISE NOTICE 'Could not add admin_permissions to realtime: %', SQLERRM;
END;
$$;

-- Step 6: Insert default permissions for existing SUPER_ADMIN users
-- ============================================================
-- This gives existing super_admins a record (they don't need restrictions but need a row)
INSERT INTO public.admin_permissions (user_id, permissions, support_ticket_categories, blurred_sections, is_active, created_by, updated_by)
SELECT 
    u.id,
    '{
        "home": {"view": true, "edit": true},
        "users": {"view": true, "edit": true},
        "customers": {"view": true, "edit": true},
        "orders-control": {"view": true, "edit": true},
        "billing": {"view": true, "edit": true},
        "financials": {"view": true, "edit": true},
        "audit-logs": {"view": true, "edit": true},
        "security-audit": {"view": true, "edit": true},
        "settings": {"view": true, "edit": true},
        "support": {"view": true, "edit": true},
        "resolution": {"view": true, "edit": true},
        "violations": {"view": true, "edit": true},
        "shipping": {"view": true, "edit": true},
        "reviews": {"view": true, "edit": true},
        "chats": {"view": true, "edit": true},
        "chat-monitoring": {"view": true, "edit": true},
        "access-control": {"view": true, "edit": true}
    }'::jsonb,
    ARRAY['TECHNICAL', 'PAYMENT', 'ORDERS', 'STORES', 'RETURNS', 'VIOLATIONS', 'DELIVERY', 'ACCOUNT', 'OTHER'],
    ARRAY[]::text[],
    true,
    u.id,
    u.id
FROM public.users u
WHERE u.role = 'SUPER_ADMIN'
ON CONFLICT (user_id) DO NOTHING;

-- Step 7: Verify migration
-- ============================================================
DO $$
DECLARE
    rec_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO rec_count FROM public.admin_permissions;
    RAISE NOTICE '✅ admin_permissions table created successfully with % rows', rec_count;
END;
$$;

-- ============================================================
-- ✅ Migration Complete!
-- الجدول تم إنشاؤه بنجاح
-- ============================================================
