
import { PrismaClient } from '@prisma/client';

async function main() {
    const prisma = new PrismaClient();
    try {
        const indexes = await prisma.$queryRawUnsafe(`
            SELECT indexname, indexdef 
            FROM pg_indexes 
            WHERE tablename = 'order_chats';
        `);
        console.log('INDEXES:');
        console.log(JSON.stringify(indexes, null, 2));

        const constraints = await prisma.$queryRawUnsafe(`
            SELECT conname, pg_get_constraintdef(oid) 
            FROM pg_constraint 
            WHERE conrelid = 'order_chats'::regclass;
        `);
        console.log('\nCONSTRAINTS:');
        console.log(JSON.stringify(constraints, null, 2));
    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
