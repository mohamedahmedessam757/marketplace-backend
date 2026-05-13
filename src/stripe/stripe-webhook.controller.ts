import { Controller, Post, Req, Res, RawBodyRequest, Logger, Inject, forwardRef } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { StripeService } from './stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';

@SkipThrottle()
@Controller('stripe/webhook')
export class StripeWebhookController {
    private readonly logger = new Logger(StripeWebhookController.name);

    constructor(
        private readonly stripeService: StripeService,
        private readonly prisma: PrismaService,
        @Inject(forwardRef(() => PaymentsService))
        private readonly paymentsService: PaymentsService,
    ) {}

    @Post()
    async handleWebhook(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
        const sig = req.headers['stripe-signature'];
        if (!sig || !req.rawBody) {
             this.logger.error('Missing stripe signature or raw body');
             return res.status(400).send('Missing stripe signature or raw body');
        }

        let event;

        try {
            event = this.stripeService.constructWebhookEvent(req.rawBody, sig as string);
        } catch (err: any) {
            this.logger.error(`⚠️ Webhook signature verification failed: ${err.message}`);
            return res.status(400).send(`Webhook Error: Signature verification failed`);
        }

        // Successfully constructed event
        this.logger.log(`✅ Success: Webhook constructed for event: ${event.type}`);

        try {
            switch (event.type) {
                case 'payment_intent.succeeded':
                    const paymentIntent = event.data.object;
                    this.logger.log(`PaymentIntent for ${paymentIntent.amount} was successful!`);
                    await this.paymentsService.fulfillStripePayment(paymentIntent.id);
                    break;
                case 'payment_intent.payment_failed':
                    const failedIntent = event.data.object;
                    this.logger.warn(`PaymentIntent for ${failedIntent.amount} failed: ${failedIntent.last_payment_error?.message}`);
                    await this.paymentsService.handlePaymentFailure(failedIntent.id);
                    break;
                case 'account.updated':
                    const account = event.data.object;
                    if (account.details_submitted) {
                        try {
                            const meta = account.metadata || {};
                            const entityId = meta.storeId || meta.id;
                            if (entityId && meta.type === 'store') {
                                await this.prisma.store.update({
                                    where: { id: entityId },
                                    data: { stripeOnboarded: account.details_submitted }
                                });
                                this.logger.log(`Store ${entityId} stripe onboarding completed.`);
                            } else if (entityId && meta.type === 'customer') {
                                const uid = entityId.startsWith('cust_') ? entityId.slice(5) : entityId;
                                await this.prisma.user.update({
                                    where: { id: uid },
                                    data: { stripeOnboarded: account.details_submitted }
                                });
                                this.logger.log(`Customer ${uid} stripe onboarding completed.`);
                            }
                        } catch(e) {
                             this.logger.error('Could not update onboarding status from Stripe account.updated', e);
                        }
                    }
                    break;
                case 'charge.refunded':
                    const charge = event.data.object;
                    await this.paymentsService.handleStripeChargeRefunded(charge);
                    break;
                default:
                    this.logger.log(`Unhandled event type ${event.type}`);
            }
        } catch (error) {
            this.logger.error(`Error processing webhook event ${event.type}:`, error);
            return res.status(500).json({ error: 'webhook_processing_failed' });
        }

        res.json({received: true});
    }
}
