import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Starting Supabase SQL manual migration...');

    try {
        console.log('1. Adding store_code column to stores...');
        await prisma.$executeRawUnsafe(`ALTER TABLE stores ADD COLUMN store_code TEXT UNIQUE;`);
    } catch (e: any) {
        console.log('Column store_code may already exist:', e.message);
    }

    try {
        console.log('2. Auto-populating existing stores with D-XXXX codes...');
        await prisma.$executeRawUnsafe(`
      UPDATE stores SET store_code = 'D-' || LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0')
      WHERE store_code IS NULL;
    `);
    } catch (e: any) {
        console.log('Error populating store_code:', e.message);
    }

    try {
        console.log('3. Making store_code NOT NULL...');
        await prisma.$executeRawUnsafe(`ALTER TABLE stores ALTER COLUMN store_code SET NOT NULL;`);
    } catch (e: any) {
        console.log('Error making store_code NOT NULL:', e.message);
    }

    try {
        console.log('4. Adding offer_number column to offers...');
        await prisma.$executeRawUnsafe(`ALTER TABLE offers ADD COLUMN offer_number TEXT UNIQUE;`);
    } catch (e: any) {
        console.log('Column offer_number may already exist:', e.message);
    }

    try {
        console.log('5. Auto-populating existing offers with OFR-XXXXXXXX codes...');
        await prisma.$executeRawUnsafe(`
      UPDATE offers SET offer_number = 'OFR-' || LPAD(FLOOR(RANDOM() * 100000000)::TEXT, 8, '0')
      WHERE offer_number IS NULL;
    `);
    } catch (e: any) {
        console.log('Error populating offer_number:', e.message);
    }

    try {
        console.log('6. Making offer_number NOT NULL...');
        await prisma.$executeRawUnsafe(`ALTER TABLE offers ALTER COLUMN offer_number SET NOT NULL;`);
    } catch (e: any) {
        console.log('Error making offer_number NOT NULL:', e.message);
    }

    console.log('Migration completed successfully!');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
