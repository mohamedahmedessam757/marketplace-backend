import { Controller, Post, Req, Res, RawBodyRequest, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { StripeService } from './stripe.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('stripe/webhook')
export class StripeWebhookController {
    private readonly logger = new Logger(StripeWebhookController.name);

    constructor(
        private readonly stripeService: StripeService,
        private readonly prisma: PrismaService,
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
                    // Note: Handle fulfilling the order in EscrowService to avoid circular dependency here.
                    // Or call EscrowService here if injected.
                    break;
                case 'account.updated':
                    const account = event.data.object;
                    if (account.details_submitted) {
                        try {
                            const storeId = account.metadata?.storeId;
                            if (storeId) {
                                await this.prisma.store.update({
                                    where: { id: storeId },
                                    data: { stripeOnboarded: account.details_submitted }
                                });
                                this.logger.log(`Store ${storeId} stripe onboarding completed.`);
                            }
                        } catch(e) {
                             this.logger.error('Could not update store onboarding status', e);
                        }
                    }
                    break;
                case 'charge.refunded':
                    const charge = event.data.object;
                    this.logger.log(`Charge refunded: ${charge.amount_refunded}`);
                    break;
                default:
                    this.logger.log(`Unhandled event type ${event.type}`);
            }
        } catch (error) {
            this.logger.error(`Error processing webhook event ${event.type}:`, error);
        }

        // Return a response to acknowledge receipt of the event
        res.json({received: true});
    }
}
