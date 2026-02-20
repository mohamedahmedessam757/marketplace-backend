
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Starting DB structure fix...');

    try {
        // 1. Fix Support Tickets Table - Add user_type column
        console.log('Checking support_tickets table...');
        await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'support_tickets' AND column_name = 'user_type') THEN
              ALTER TABLE support_tickets ADD COLUMN user_type TEXT NOT NULL DEFAULT 'customer';
              RAISE NOTICE 'Added user_type column';
          ELSE
              RAISE NOTICE 'user_type column already exists';
          END IF;
      END $$;
    `);
        console.log('✅ support_tickets table fixed.');

        // 2. Fix Storage Bucket
        console.log('Checking storage buckets...');
        try {
            await prisma.$executeRawUnsafe(`
            INSERT INTO storage.buckets (id, name, public) 
            VALUES ('support-files', 'support-files', true)
            ON CONFLICT (id) DO NOTHING;
        `);
            console.log('✅ support-files bucket ensured.');
        } catch (e) {
            console.warn('⚠️ Could not create bucket via SQL (common if permission denied), please create manually in dashboard if upload fails.', e.message);
        }

        // 3. Fix Storage Policy (One by one)
        console.log('Attempting to update storage policies...');
        try {
            await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS "Allow public uploads" ON storage.objects`);
            await prisma.$executeRawUnsafe(`CREATE POLICY "Allow public uploads" ON storage.objects FOR INSERT TO public WITH CHECK (bucket_id = 'support-files')`);

            await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS "Allow public viewing" ON storage.objects`);
            await prisma.$executeRawUnsafe(`CREATE POLICY "Allow public viewing" ON storage.objects FOR SELECT TO public USING (bucket_id = 'support-files')`);

            console.log('✅ Storage policies updated.');
        } catch (e) {
            console.warn('⚠️ Could not update policies via SQL (permissions). Please run backend/supabase_storage_policy_v2.sql in Dashboard.', e.message);
        }
    } catch (error) {
        console.error('❌ Error during fix:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
