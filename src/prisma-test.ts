import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient({
    log: ['query', 'info', 'warn', 'error'],
  });

  try {
    console.log('--- Testing Database Connection ---');
    console.log('Checking if Prisma can reach the database...');
    
    // Attempt a simple raw query to check connection
    const result = await prisma.$queryRaw`SELECT 1 as connected`;
    console.log('Connection Status:', result);
    console.log('SUCCESS: Database is reachable.');
    
  } catch (error) {
    console.error('ERROR: Could not connect to the database.');
    console.error('Prisma Error Code:', error.code);
    console.error('Prisma Error Message:', error.message);
    
    if (error.code === 'P1001') {
      console.log('\n--- RECOMMENDATION ---');
      console.log('1. Visit Supabase Dashboard: https://supabase.com/dashboard');
      console.log('2. Ensure project "yhasbbmieqcgyjktgyro" is ACTIVE (not paused).');
      console.log('3. Check if your current network blocks port 6543.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main();
