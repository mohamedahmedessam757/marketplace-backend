import { Controller, Post, Get, Body, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ConfigService } from '@nestjs/config';

@Controller('stripe')
@UseGuards(JwtAuthGuard)
export class StripeController {
    constructor(
        private readonly stripeService: StripeService,
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService,
    ) {}

    @Post('onboarding-link')
    async getOnboardingLink(@Req() req) {
        const userId = req.user.id;
        let frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173';
        if (frontendUrl.endsWith('/')) frontendUrl = frontendUrl.slice(0, -1);
        
        // Find store
        const store = await this.prisma.store.findUnique({
            where: { ownerId: userId }
        });

        if (!store) {
            // Check if user is a customer and create account for them
            const user = await this.prisma.user.findUnique({ where: { id: userId } });
            if (!user) throw new BadRequestException('User not found');
            
            let stripeAccountId = user.stripeAccountId;
            if (!stripeAccountId) {
                const account = await this.stripeService.createConnectedAccount(`cust_${user.id}`, user.email, true);
                stripeAccountId = account.id;
                await this.prisma.user.update({
                    where: { id: userId },
                    data: { stripeAccountId }
                });
            }

            const returnUrl = `${frontendUrl}/dashboard/wallet?stripe_status=return`; 
            const refreshUrl = `${frontendUrl}/dashboard/wallet?stripe_status=refresh`;

            const link = await this.stripeService.createOnboardingLink(stripeAccountId, returnUrl, refreshUrl);
            return { url: link };
        }

        let stripeAccountId = store.stripeAccountId;

        // Create stripe account if not exists
        if (!stripeAccountId) {
            const user = await this.prisma.user.findUnique({ where: { id: userId } });
            const account = await this.stripeService.createConnectedAccount(store.id, user?.email || '');
            stripeAccountId = account.id;
            await this.prisma.store.update({
                where: { id: store.id },
                data: { stripeAccountId }
            });
        }

        const returnUrl = `${frontendUrl}/dashboard/wallet?stripe_status=return`; 
        const refreshUrl = `${frontendUrl}/dashboard/wallet?stripe_status=refresh`;

        const link = await this.stripeService.createOnboardingLink(stripeAccountId, returnUrl, refreshUrl);
        return { url: link };
    }

    @Get('dashboard-link')
    async getDashboardLink(@Req() req) {
        const userId = req.user.id;
        const store = await this.prisma.store.findUnique({
            where: { ownerId: userId }
        });

        if (store?.stripeAccountId) {
            const url = await this.stripeService.createLoginLink(store.stripeAccountId);
            return { url };
        }

        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (user?.stripeAccountId) {
            const url = await this.stripeService.createLoginLink(user.stripeAccountId);
            return { url };
        }

        throw new BadRequestException('No Stripe account connected');
    }

    @Get('status')
    async getStripeStatus(@Req() req) {
        const userId = req.user.id;
        
        // 1. Check Store (Merchant)
        const store = await this.prisma.store.findUnique({
            where: { ownerId: userId },
            select: { id: true, stripeAccountId: true, stripeOnboarded: true, payoutSchedule: true }
        });

        if (store) {
            if (store.stripeAccountId && !store.stripeOnboarded) {
                try {
                    const stripeClient = this.stripeService.getStripeClient();
                    const account = await stripeClient.accounts.retrieve(store.stripeAccountId);
                    if (account.details_submitted) {
                        await this.prisma.store.update({
                            where: { id: store.id },
                            data: { stripeOnboarded: true }
                        });
                        return { stripeAccountId: store.stripeAccountId, stripeOnboarded: true, payoutSchedule: store.payoutSchedule };
                    }
                } catch (error) {
                    console.error('Stripe status check failed for store:', error.message);
                }
            }
            return { stripeAccountId: store.stripeAccountId, stripeOnboarded: store.stripeOnboarded, payoutSchedule: store.payoutSchedule };
        }

        // 2. Check User (Customer)
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { stripeAccountId: true, stripeOnboarded: true }
        });

        if (user) {
            if (user.stripeAccountId && !user.stripeOnboarded) {
                try {
                    const stripeClient = this.stripeService.getStripeClient();
                    const account = await stripeClient.accounts.retrieve(user.stripeAccountId);
                    if (account.details_submitted) {
                        await this.prisma.user.update({
                            where: { id: userId },
                            data: { stripeOnboarded: true }
                        });
                        return { stripeAccountId: user.stripeAccountId, stripeOnboarded: true };
                    }
                } catch (error) {
                    console.error('Stripe status check failed for user:', error.message);
                }
            }
            return { stripeAccountId: user?.stripeAccountId, stripeOnboarded: user?.stripeOnboarded };
        }

        return { stripeOnboarded: false };
    }

}
