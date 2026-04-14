import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PaymentsService } from '../src/payments/payments.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Verification Script for Phase 4: Backend Fulfillment Logic
 * This script selects a pending transaction and manually triggers the fulfillment logic
 * to ensure all database records (Wallet, Escrow, Invoice, Order) are correctly updated.
 */
async function bootstrap() {
    const app = await NestFactory.createApplicationContext(AppModule);
    const paymentsService = app.get(PaymentsService);
    const prisma = app.get(PrismaService);

    console.log('--- STARTING VERIFICATION ---');

    // 1. Find a pending transaction to test with
    const pendingTx = await prisma.paymentTransaction.findFirst({
        where: { 
            status: 'PENDING',
            stripePaymentId: { not: null }
        },
        include: { order: true }
    });

    if (!pendingTx) {
        console.error('No pending transaction found with a stripePaymentId. Please create a payment intent first via the UI or API.');
        await app.close();
        return;
    }

    console.log(`Found pending transaction: ID ${pendingTx.id}, Order ${pendingTx.orderId}`);
    console.log(`Simulating fulfillment for Stripe ID: ${pendingTx.stripePaymentId}`);

    try {
        // 2. Trigger Fulfillment
        await paymentsService.fulfillStripePayment(pendingTx.stripePaymentId!);
        
        console.log('✅ Fulfillment call completed.');

        // 3. Verify Results
        const updatedTx = await prisma.paymentTransaction.findUnique({ where: { id: pendingTx.id } });
        const walletTx = await prisma.walletTransaction.findFirst({ where: { paymentId: pendingTx.id } });
        const escrowTx = await prisma.escrowTransaction.findFirst({ where: { paymentId: pendingTx.id } });
        const invoice = await prisma.invoice.findFirst({ where: { paymentId: pendingTx.id } });
        const order = await prisma.order.findUnique({ where: { id: pendingTx.orderId } });

        const unitPrice = Number(pendingTx.unitPrice);
        const commission = Number(pendingTx.commission);
        const shipping = Number(pendingTx.shippingCost);
        const expectedMerchantNet = unitPrice - commission - shipping;

        console.log('--- VERIFICATION RESULTS (All-Inclusive Model) ---');
        console.log('Payment Status:', updatedTx?.status); // Expected: SUCCESS
        console.log('Customer Paid:', updatedTx?.totalAmount); // Expected: unitPrice (e.g. 1500)
        console.log('Merchant Net Credit:', walletTx?.amount); // Expected: expectedMerchantNet
        console.log('Escrow Merchant Share:', escrowTx?.merchantAmount); // Expected: expectedMerchantNet
        console.log('Escrow Admin Share (Comm + Ship):', Number(escrowTx?.commissionAmount) + Number(escrowTx?.shippingAmount));
        console.log('Order Status:', order?.status); 
        
        const isWalletCorrect = Number(walletTx?.amount) === expectedMerchantNet;
        const isEscrowCorrect = Number(escrowTx?.merchantAmount) === expectedMerchantNet;
        const isTotalCorrect = Number(updatedTx?.totalAmount) === unitPrice;

        if (updatedTx?.status === 'SUCCESS' && isWalletCorrect && isEscrowCorrect && isTotalCorrect && !!invoice) {
            console.log('\n🌟 ALL SYSTEMS VERIFIED: PRICING IS NOW 100% SYNCED! 🌟');
        } else {
            console.error('\n❌ Verification Failed: Pricing discrepancy detected.');
            console.log('Details:', { isWalletCorrect, isEscrowCorrect, isTotalCorrect });
        }

    } catch (error) {
        console.error('❌ Error during verification:', error);
    } finally {
        await app.close();
    }
}

bootstrap();
