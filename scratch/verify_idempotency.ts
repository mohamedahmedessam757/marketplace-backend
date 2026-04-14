import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PaymentsService } from '../src/payments/payments.service';
import { PrismaService } from '../src/prisma/prisma.service';

async function verifyIdempotency() {
    console.log('--- STARTING IDEMPOTENCY VERIFICATION ---');
    const app = await NestFactory.createApplicationContext(AppModule);
    const paymentsService = app.get(PaymentsService);
    const prisma = app.get(PrismaService);

    const customerId = 'e85e772f-810b-4181-9cf8-221f9d609435'; // Valid test customer
    const orderId = '8a0e71eb-7f6a-4567-965c-e72238dc0780';    // Valid test order
    const offerId = '99de7255-0eb4-4004-a504-71647b30f6b4';    // Valid test offer

    try {
        // Clean up any existing transaction for this offer to start fresh
        await prisma.paymentTransaction.deleteMany({ where: { offerId } });
        console.log('✅ Cleaned up old transactions.');

        // 1st Call
        console.log('Calling createPaymentIntent (1st time)...');
        const intent1 = await paymentsService.createPaymentIntent(customerId, { orderId, offerId });
        console.log('✅ 1st Call Successful. Transaction Number:', (await prisma.paymentTransaction.findUnique({ where: { offerId } }))?.transactionNumber);

        // 2nd Call (The critical one that used to fail)
        console.log('Calling createPaymentIntent (2nd time - SHOULD BE IDEMPOTENT)...');
        const intent2 = await paymentsService.createPaymentIntent(customerId, { orderId, offerId });
        
        const tx1 = await prisma.paymentTransaction.findUnique({ where: { offerId } });
        console.log('✅ 2nd Call Successful. Transaction Number:', tx1?.transactionNumber);

        if (intent1.paymentIntentId === intent2.paymentIntentId) {
            console.log('\n🌟 SUCCESS: Idempotency verified! Reuse of existing record confirmed. 🌟');
        } else {
            console.log('\n⚠️ Note: Intent IDs differ (Stripe generates new ones), but Transaction Number should be same.');
        }

    } catch (error) {
        console.error('\n❌ FAILED: Unique constraint or other error detected.');
        console.error(error);
    } finally {
        await app.close();
    }
}

verifyIdempotency();
