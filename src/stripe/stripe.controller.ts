import { Controller, Post, Get, Body, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('stripe')
@UseGuards(JwtAuthGuard)
export class StripeController {
    constructor(
        private readonly stripeService: StripeService,
        private readonly prisma: PrismaService,
    ) {}

    @Post('onboarding-link')
    async getOnboardingLink(@Req() req) {
        const userId = req.user.id;
        
        // Find store
        const store = await this.prisma.store.findUnique({
            where: { ownerId: userId }
        });

        if (!store) {
            throw new BadRequestException('Store not found for this user');
        }

        let stripeAccountId = store.stripeAccountId;

        // Create stripe account if not exists
        if (!stripeAccountId) {
            const user = await this.prisma.user.findUnique({ where: { id: userId } });
            const account = await this.stripeService.createConnectedAccount(store.id, user?.email || '');
            stripeAccountId = account.id;
        }

        if (!stripeAccountId) {
            throw new BadRequestException('Failed to create or retrieve Stripe Account ID');
        }

        // We assume frontend is running on standard ports, can be dynamic from env
        // Using localhost for dev, in production use actual domain
        const returnUrl = `http://localhost:5173/dashboard/profile?stripe_status=return`; // Example frontend URLs
        const refreshUrl = `http://localhost:5173/dashboard/profile?stripe_status=refresh`;

        const link = await this.stripeService.createOnboardingLink(stripeAccountId, returnUrl, refreshUrl);
        return { url: link };
    }

    @Get('dashboard-link')
    async getDashboardLink(@Req() req) {
        const userId = req.user.id;
        const store = await this.prisma.store.findUnique({
            where: { ownerId: userId }
        });

        if (!store || !store.stripeAccountId) {
            throw new BadRequestException('No Stripe account connected');
        }

        const url = await this.stripeService.createLoginLink(store.stripeAccountId);
        return { url };
    }

    @Get('status')
    async getStripeStatus(@Req() req) {
        const userId = req.user.id;
        const store = await this.prisma.store.findUnique({
            where: { ownerId: userId },
            select: { stripeAccountId: true, stripeOnboarded: true, payoutSchedule: true }
        });

        if (!store) return { stripeOnboarded: false };
        
        // If they have an account, maybe double check status with Stripe API directly (optional)
        if (store.stripeAccountId && !store.stripeOnboarded) {
             const stripeClient = this.stripeService.getStripeClient();
             const account = await stripeClient.accounts.retrieve(store.stripeAccountId);
             if (account.details_submitted) {
                 await this.prisma.store.update({
                     where: { ownerId: userId },
                     data: { stripeOnboarded: true }
                 });
                 return { stripeAccountId: store.stripeAccountId, stripeOnboarded: true, payoutSchedule: store.payoutSchedule };
             }
        }

        return store;
    }
}
