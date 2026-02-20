
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔄 Starting Support Table Reset (Refactor to UUID)...');

  try {
    // 1. Drop existing tables to clear old schema (Int IDs)
    console.log('🗑️ Dropping existing tables...');

    // Drop ticket_messages first (depends on support_tickets)
    try {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "ticket_messages" CASCADE;`);
      console.log(' - Dropped ticket_messages');
    } catch (e) {
      console.warn(' - Failed to drop ticket_messages:', e.message);
    }

    try {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "support_tickets" CASCADE;`);
      console.log(' - Dropped support_tickets');
    } catch (e) {
      console.warn(' - Failed to drop support_tickets:', e.message);
    }

    // 2. Recreate tables with clean schema using RAW SQL to ensure it matches desired state
    // We use RAW SQL because we want to strictly enforce the new UUID structure without relying on migrations
    console.log('🛠️ Recreating support_tickets table...');
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "support_tickets" (
        "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
        "ticket_number" TEXT NOT NULL,
        "subject" TEXT NOT NULL,
        "message" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'OPEN',
        "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
        "user_id" UUID NOT NULL,
        "user_type" TEXT NOT NULL DEFAULT 'customer',
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        
        CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
      );
    `);

    // Unique index on ticket_number
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX "support_tickets_ticket_number_key" ON "support_tickets"("ticket_number");
    `);

    console.log('🛠️ Recreating ticket_messages table...');
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "ticket_messages" (
        "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
        "ticket_id" TEXT NOT NULL,
        "sender_id" UUID NOT NULL,
        "sender_role" TEXT NOT NULL DEFAULT 'user',
        "text" TEXT NOT NULL,
        "media_url" TEXT,
        "media_type" TEXT,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        
        CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id")
      );
    `);

    // Foreign key and index
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX "ticket_messages_ticket_id_idx" ON "ticket_messages"("ticket_id");
    `);

    console.log('✅ Tables recreated successfully with UUIDs.');

  } catch (error) {
    console.error('❌ Error during reset:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
