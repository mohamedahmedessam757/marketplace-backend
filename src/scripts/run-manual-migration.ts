import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log('Running manual migration...');
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "fingerprint" TEXT;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "sessions_fingerprint_idx" ON "sessions"("fingerprint");
    `);
    console.log('Migration successful!');
  } catch (e) {
    console.error('Migration failed:', e);
  } finally {
    await prisma.$disconnect();
  }
}

main();
