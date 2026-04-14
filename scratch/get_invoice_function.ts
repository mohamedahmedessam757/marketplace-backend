import { PrismaClient } from '@prisma/client';

async function getFunction() {
  const prisma = new PrismaClient();
  try {
    const result: any = await prisma.$queryRaw`
      SELECT routine_definition 
      FROM information_schema.routines 
      WHERE routine_name = 'generate_invoice_number'
    `;
    console.log(result[0]?.routine_definition);
  } catch (e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
}

getFunction();
