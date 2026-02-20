
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('🔄 Creating Order Chat Tables...');

    try {
        // 1. Create order_chats table
        console.log('🛠️ Creating order_chats table...');
        await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "order_chats" (
        "id" UUID NOT NULL DEFAULT gen_random_uuid(),
        "order_id" UUID NOT NULL,
        "vendor_id" UUID NOT NULL,
        "customer_id" UUID NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'OPEN',
        "expiry_at" TIMESTAMPTZ NOT NULL,
        "is_translation_enabled" BOOLEAN NOT NULL DEFAULT false,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT "order_chats_pkey" PRIMARY KEY ("id")
      );
    `);

        // Add Constraints & Indexes for order_chats
        // We wrap in try-catch blocks to avoid errors if they already exist (idempotency)
        try {
            await prisma.$executeRawUnsafe(`ALTER TABLE "order_chats" ADD CONSTRAINT "order_chats_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;`);
        } catch { }
        try {
            await prisma.$executeRawUnsafe(`ALTER TABLE "order_chats" ADD CONSTRAINT "order_chats_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;`);
        } catch { }
        try {
            await prisma.$executeRawUnsafe(`ALTER TABLE "order_chats" ADD CONSTRAINT "order_chats_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;`);
        } catch { }

        try {
            await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX "order_chats_order_id_vendor_id_key" ON "order_chats"("order_id", "vendor_id");`);
        } catch { }


        // 2. Create order_chat_messages table
        console.log('🛠️ Creating order_chat_messages table...');
        await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "order_chat_messages" (
        "id" UUID NOT NULL DEFAULT gen_random_uuid(),
        "chat_id" UUID NOT NULL,
        "sender_id" UUID NOT NULL,
        "text" TEXT NOT NULL,
        "translated_text" TEXT,
        "is_read" BOOLEAN NOT NULL DEFAULT false,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT "order_chat_messages_pkey" PRIMARY KEY ("id")
      );
    `);

        // Add Constraints & Indexes for order_chat_messages
        try {
            await prisma.$executeRawUnsafe(`ALTER TABLE "order_chat_messages" ADD CONSTRAINT "order_chat_messages_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "order_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;`);
        } catch { }
        try {
            await prisma.$executeRawUnsafe(`CREATE INDEX "order_chat_messages_chat_id_idx" ON "order_chat_messages"("chat_id");`);
        } catch { }

        console.log('✅ Order Chat Tables created successfully.');

    } catch (error) {
        console.error('❌ Error creating tables:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
