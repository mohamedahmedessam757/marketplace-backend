import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Altering notifications table to add recipient_role...');

    try {
        // Check if column exists, if not add it
        await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT
          FROM information_schema.columns
          WHERE table_name='notifications' AND column_name='recipient_role'
        ) THEN
          ALTER TABLE "notifications" ADD COLUMN "recipient_role" VARCHAR NOT NULL DEFAULT 'CUSTOMER';
        END IF;
      END
      $$;
    `);
        console.log('Column recipient_role added successfully.');
    } catch (error) {
        console.error('Error altering table:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
