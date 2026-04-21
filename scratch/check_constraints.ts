
import { PrismaClient } from '@prisma/client';

async function main() {
    const prisma = new PrismaClient();
    try {
        const result = await prisma.$queryRaw`
            SELECT 
                conname as constraint_name, 
                pg_get_constraintdef(c.oid) as constraint_definition
            FROM 
                pg_constraint c 
            JOIN 
                pg_class t ON c.conrelid = t.oid 
            WHERE 
                t.relname = 'order_chats';
        `;
        console.log(JSON.stringify(result, null, 2));
    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
