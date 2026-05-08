-- Admin Permissions & RLS Configuration (2026 Standards)
-- Purpose: Ensures the admin_permissions table is synced and RLS is enabled for real-time dashboard updates.

-- 1. Create table if not exists (should be handled by Prisma, but manual sync for safety)
CREATE TABLE IF NOT EXISTS public.admin_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    permissions JSONB DEFAULT '{}'::jsonb,
    support_ticket_categories TEXT[] DEFAULT '{}',
    blurred_sections TEXT[] DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_by UUID REFERENCES public.users(id),
    updated_by UUID REFERENCES public.users(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Enable Row Level Security
ALTER TABLE public.admin_permissions ENABLE ROW LEVEL SECURITY;

-- 3. Create RLS Policies
-- Policy: Allow admins to read their own permissions
DROP POLICY IF EXISTS "Admins can read their own permissions" ON public.admin_permissions;
CREATE POLICY "Admins can read their own permissions" 
ON public.admin_permissions
FOR SELECT 
USING (auth.uid() = user_id);

-- Policy: Allow Super Admins to manage everything
DROP POLICY IF EXISTS "Super Admins can manage all permissions" ON public.admin_permissions;
CREATE POLICY "Super Admins can manage all permissions" 
ON public.admin_permissions
FOR ALL 
USING (
    EXISTS (
        SELECT 1 FROM public.users 
        WHERE id = auth.uid() AND role = 'SUPER_ADMIN'
    )
);

-- 4. Enable Realtime for admin_permissions
-- Ensure the table is added to the supabase_realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.admin_permissions;

-- 5. Helper Function to get permissions (Optional but useful for SQL queries)
CREATE OR REPLACE FUNCTION public.get_admin_permissions(target_user_id UUID)
RETURNS JSONB AS $$
BEGIN
    RETURN (SELECT permissions FROM public.admin_permissions WHERE user_id = target_user_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
