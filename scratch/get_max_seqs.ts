import { PrismaClient } from '@prisma/client';

async function getMaxSeqs() {
  const prisma = new PrismaClient();
  try {
    const txs: any = await prisma.$queryRaw`SELECT transaction_number FROM payment_transactions`;
    const invs: any = await prisma.$queryRaw`SELECT invoice_number FROM invoices`;

    const getSeq = (str: string) => {
      const parts = str.split('-');
      return parseInt(parts[parts.length - 1], 10);
    };

    const maxTxSeq = txs.reduce((max: number, row: any) => Math.max(max, getSeq(row.transaction_number)), 0);
    const maxInvSeq = invs.reduce((max: number, row: any) => Math.max(max, getSeq(row.invoice_number)), 0);

    console.log(JSON.stringify({ maxTxSeq, maxInvSeq }, null, 2));
  } catch (e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
}

getMaxSeqs();
