import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe = require('stripe');
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StripeService {
    private readonly stripe: any;
    private readonly logger = new Logger(StripeService.name);

    constructor(
        private configService: ConfigService,
        private prisma: PrismaService,
    ) {
        const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
        if (!secretKey) {
            this.logger.warn('STRIPE_SECRET_KEY is missing from environment variables');
        }
        this.stripe = new Stripe(secretKey || '', {
            apiVersion: '2026-03-25.dahlia' as any, // latest stable typings
        });
    }

    /**
     * Creates a new connected Express account
     */
    async createConnectedAccount(storeId: string, email: string): Promise<any> {
        const account = await this.stripe.accounts.create({
            controller: {
                fees: { payer: 'application' },
                losses: { payments: 'application' },
                stripe_dashboard: { type: 'express' },
                requirement_collection: 'stripe',
            },
            email: email,
            metadata: { storeId },
            settings: {
                payouts: {
                    schedule: { interval: 'manual' } // Important for Escrow
                }
            }
        } as any);

        await this.prisma.store.update({
            where: { id: storeId },
            data: { 
                stripeAccountId: account.id,
                payoutSchedule: 'MANUAL'
            }
        });

        return account;
    }

    /**
     * Creates an onboarding URL for the connected account
     */
    async createOnboardingLink(accountId: string, returnUrl: string, refreshUrl: string): Promise<string> {
        const accountLink = await this.stripe.accountLinks.create({
            account: accountId,
            refresh_url: refreshUrl,
            return_url: returnUrl,
            type: 'account_onboarding',
        });
        return accountLink.url;
    }

    /**
     * View Stripe Dashboard link (Express accounts)
     */
    async createLoginLink(accountId: string): Promise<string> {
        const loginLink = await this.stripe.accounts.createLoginLink(accountId);
        return loginLink.url;
    }

    /**
     * Creates a PaymentIntent (Funds Held in Platform)
     * For Separate Charges and Transfers.
     */
    async createPaymentIntent(amountStr: string, currency: string, metadata: any): Promise<any> {
        const amountCents = Math.round(parseFloat(amountStr) * 100);
        
        return await this.stripe.paymentIntents.create({
            amount: amountCents,
            currency: currency,
            metadata: metadata,
            transfer_group: metadata.orderId, // Grouping to link transfers later
            // We do NOT use application_fee_amount or on_behalf_of here.
        });
    }

    /**
     * Creates a destination transfer, releasing funds from Platform to Merchant.
     */
    async createTransfer(amountStr: string, currency: string, connectedAccountId: string, transferGroup: string, metadata: any): Promise<any> {
        const amountCents = Math.round(parseFloat(amountStr) * 100);

        try {
            return await this.stripe.transfers.create({
                amount: amountCents,
                currency,
                destination: connectedAccountId,
                transfer_group: transferGroup,
                metadata: metadata
            });
        } catch (error: any) {
            this.logger.error(`Failed to transfer funds to ${connectedAccountId}`, error.message);
            throw new BadRequestException(`Transfer failed: ${error.message}`);
        }
    }

    /**
     * Request payout from connected account balance to external bank.
     */
    async createPayout(amountStr: string, currency: string, connectedAccountId: string): Promise<any> {
        const amountCents = Math.round(parseFloat(amountStr) * 100);
        
        try {
            return await this.stripe.payouts.create(
                {
                    amount: amountCents,
                    currency,
                },
                { stripeAccount: connectedAccountId }
            );
        } catch (error: any) {
            this.logger.error(`Failed to execute payout for ${connectedAccountId}`, error.message);
            throw new BadRequestException(`Payout failed: ${error.message}`);
        }
    }

    /**
     * Refund a PaymentIntent (full or partial)
     */
    async createRefund(paymentIntentId: string, amountStr?: string): Promise<any> {
        const params: any = {
            payment_intent: paymentIntentId,
        };
        if (amountStr) {
            params.amount = Math.round(parseFloat(amountStr) * 100);
        }
        return await this.stripe.refunds.create(params);
    }

    constructWebhookEvent(body: Buffer, sig: string): any {
        const endpointSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
        if (!endpointSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
        return this.stripe.webhooks.constructEvent(body, sig, endpointSecret);
    }

    // Helper to get raw stripe client if needed
    getStripeClient(): any {
        return this.stripe;
    }
}
