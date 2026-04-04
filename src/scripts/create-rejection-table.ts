import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log("Executing SQL migration via Prisma Client...");
    await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS offer_rejections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        offer_id UUID UNIQUE NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
        reason TEXT NOT NULL,
        custom_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

    await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_offer_rejections_offer_id ON offer_rejections(offer_id);
  `);

    console.log("Table created successfully");
}

main().catch(e => {
    console.error("Error creating table:", e);
    process.exit(1);
}).finally(() => {
    prisma.$disconnect();
});
