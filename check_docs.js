const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
    try {
        const count = await prisma.verificationDocument.count({
            where: { orderId: '67086c0a-a710-4bc3-a083-95596fdbd1d5' }
        });
        console.log('---CHECK_RESULT---');
        console.log('DOCS_COUNT:', count);
    } catch (e) {
        console.error('Error querying:', e);
    } finally {
        await prisma.$disconnect();
    }
}
run();
