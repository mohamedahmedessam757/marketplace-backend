import { PrismaClient } from '@prisma/client';

async function findIDs() {
  const prisma = new PrismaClient();
  try {
    const result = await prisma.$queryRaw`
      SELECT u.id as customer_id, o.id as order_id, of.id as offer_id 
      FROM users u 
      JOIN orders o ON u.id = o.customer_id 
      JOIN offers of ON o.id = of.order_id 
      WHERE of.status = 'accepted' AND o.status = 'AWAITING_PAYMENT'
      LIMIT 1
    `;
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
}

findIDs();
