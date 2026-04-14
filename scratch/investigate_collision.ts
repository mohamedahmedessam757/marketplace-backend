import { PrismaClient } from '@prisma/client';

async function investigate() {
  const prisma = new PrismaClient();
  try {
    // 1. Get current Max Transaction Number
    const maxTx = await prisma.$queryRaw`SELECT MAX(transaction_number) as max_tx FROM payment_transactions`;
    console.log('Current Max TX in Table:', maxTx);

    // 2. Generate a new one via the SQL function
    const newTxResult: any = await prisma.$queryRaw`SELECT generate_transaction_number()`;
    const newTx = newTxResult[0].generate_transaction_number;
    console.log('SQL Function Generated:', newTx);

    // 3. Check if it exists
    const exists = await prisma.paymentTransaction.findUnique({
      where: { transactionNumber: newTx }
    });
    
    if (exists) {
      console.log('❌ COLLISION FOUND! The generated number exists for offer:', exists.offerId);
    } else {
      console.log('✅ Generated number is unique.');
    }

  } catch (e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
}

investigate();
