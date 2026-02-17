// scripts/test-db-connection.js
const { PrismaClient } = require('@prisma/client');

async function main() {
    console.log('Testing DB Connection...');
    const prisma = new PrismaClient();
    try {
        await prisma.$connect();
        console.log('✅ Connection Successful!');

        const count = await prisma.user.count();
        console.log(`✅ Found ${count} users in the database.`);

    } catch (error) {
        console.error('❌ Connection Failed:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
