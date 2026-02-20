import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Setting up RLS and Realtime for notifications table...');

    try {
        // 1. Enable RLS
        await prisma.$executeRawUnsafe(`ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;`);
        console.log('RLS enabled on notifications table.');

        // 2. Drop existing policies if any
        await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS "Users can view their own notifications" ON notifications;`);
        await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS "Users can update their own notifications" ON notifications;`);
        await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS "Users can insert notifications" ON notifications;`);
        await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS "System can insert notifications" ON notifications;`);

        // 3. Create Select Policy - User can only see notifications where auth.uid() == recipient_id
        await prisma.$executeRawUnsafe(`
      CREATE POLICY "Users can view their own notifications" 
      ON notifications FOR SELECT 
      USING (auth.uid() = recipient_id);
    `);

        // 4. Create Update Policy - User can only update (mark as read) their own
        await prisma.$executeRawUnsafe(`
      CREATE POLICY "Users can update their own notifications" 
      ON notifications FOR UPDATE 
      USING (auth.uid() = recipient_id);
    `);

        // 5. Create Insert Policy - Authenticated users can insert
        await prisma.$executeRawUnsafe(`
      CREATE POLICY "Users can insert notifications" 
      ON notifications FOR INSERT 
      WITH CHECK (auth.role() = 'authenticated');
    `);

        console.log('RLS Policies created successfully.');

        // 6. Add to realtime publication
        try {
            await prisma.$executeRawUnsafe(`ALTER PUBLICATION supabase_realtime ADD TABLE notifications;`);
            console.log('Added notifications to supabase_realtime publication.');
        } catch (e: any) {
            console.log('Notice: Could not add to realtime publication (might already be added):', e.message);
        }

    } catch (error) {
        console.error('Error setting up RLS:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
