
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
    console.log('--- Checking Data Persistence ---');

    // 1. Count Returns
    const returnsCount = await prisma.returnRequest.count();
    console.log(`Returns Count: ${returnsCount}`);

    const returns = await prisma.returnRequest.findMany({ take: 5 });
    console.log('Latest Returns:', JSON.stringify(returns, null, 2));

    // 2. Count Disputes
    const disputesCount = await prisma.dispute.count();
    console.log(`Disputes Count: ${disputesCount}`);

    const disputes = await prisma.dispute.findMany({ take: 5 });
    console.log('Latest Disputes:', JSON.stringify(disputes, null, 2));

    // 3. Check Order Status for specific order 8c62
    const orderId = '8c62b262-9ee5-4b59-8774-68548e61a636';
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (order) {
        console.log(`Order ${orderId} Status: ${order.status}`);
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
