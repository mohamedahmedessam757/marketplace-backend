import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { CreateCardDto } from './dto/create-card.dto';

@Injectable()
export class CardsService {
    constructor(
        private prisma: PrismaService,
        private stripeService: StripeService
    ) { }

    async getUserCards(userId: string) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { stripeCustomerId: true }
        });

        const dbCards = await this.prisma.userCard.findMany({
            where: { userId },
            orderBy: { isDefault: 'desc' },
        });

        // 2026 Sync Logic: If user has a Stripe Customer, sync payment methods
        if (user?.stripeCustomerId) {
            try {
                const stripeMethods = await this.stripeService.listPaymentMethods(user.stripeCustomerId);
                
                // Update DB cards if they are missing stripePaymentMethodId but match last4
                for (const method of stripeMethods) {
                    const match = dbCards.find(c => !c.stripePaymentMethodId && c.last4 === method.card.last4);
                    if (match) {
                        await this.prisma.userCard.update({
                            where: { id: match.id },
                            data: { stripePaymentMethodId: method.id }
                        });
                        match.stripePaymentMethodId = method.id; // Update in-memory for immediate return
                    }
                }
            } catch (err) {
                console.error('Stripe sync failed:', err.message);
            }
        }

        return dbCards;
    }

    async addCard(userId: string, dto: CreateCardDto) {
        // Check if user already has cards
        const existingCount = await this.prisma.userCard.count({
            where: { userId },
        });

        const isDefault = existingCount === 0; // First card is default

        return this.prisma.userCard.create({
            data: {
                userId,
                last4: dto.last4,
                brand: dto.brand,
                expiryMonth: dto.expiryMonth,
                expiryYear: dto.expiryYear,
                cardHolderName: dto.cardHolderName,
                isDefault,
            },
        });
    }

    async deleteCard(userId: string, cardId: string) {
        const card = await this.prisma.userCard.findFirst({
            where: { id: cardId, userId },
        });

        if (!card) {
            throw new NotFoundException('Card not found');
        }

        await this.prisma.userCard.delete({
            where: { id: cardId },
        });

        // If default was deleted, make the oldest existing card default (optional)
        if (card.isDefault) {
            const nextCard = await this.prisma.userCard.findFirst({
                where: { userId },
                orderBy: { createdAt: 'asc' },
            });
            if (nextCard) {
                await this.prisma.userCard.update({
                    where: { id: nextCard.id },
                    data: { isDefault: true },
                });
            }
        }

        return { success: true };
    }

    /**
     * Persist a card from a succeeded PaymentIntent (checkout / wallet sync).
     * Links stripePaymentMethodId so Quick Pay works on future checkouts.
     */
    async syncFromPaymentIntent(userId: string, paymentIntentId: string) {
        const stripe = this.stripeService.getStripeClient();
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId, {
            expand: ['payment_method'],
        });

        if (intent.status !== 'succeeded') {
            return null;
        }

        const pmRaw = intent.payment_method;
        if (!pmRaw) return null;

        const paymentMethodId = typeof pmRaw === 'string' ? pmRaw : pmRaw.id;
        const cardDetails = typeof pmRaw === 'object' ? pmRaw.card : null;
        if (!cardDetails) return null;

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { stripeCustomerId: true, email: true, name: true },
        });

        let stripeCustomerId = user?.stripeCustomerId;
        if (!stripeCustomerId && user?.email) {
            stripeCustomerId = await this.stripeService.getOrCreateCustomer(userId, user.email, user.name ?? undefined);
        }
        if (!stripeCustomerId) return null;

        await this.stripeService.attachPaymentMethod(paymentMethodId, stripeCustomerId);

        const existingByPm = await this.prisma.userCard.findFirst({
            where: { userId, stripePaymentMethodId: paymentMethodId },
        });
        if (existingByPm) return existingByPm;

        const existingByLast4 = await this.prisma.userCard.findFirst({
            where: { userId, last4: cardDetails.last4 },
        });
        if (existingByLast4) {
            return this.prisma.userCard.update({
                where: { id: existingByLast4.id },
                data: {
                    stripePaymentMethodId: paymentMethodId,
                    brand: cardDetails.brand ?? existingByLast4.brand,
                    expiryMonth: cardDetails.exp_month ?? existingByLast4.expiryMonth,
                    expiryYear: cardDetails.exp_year ?? existingByLast4.expiryYear,
                },
            });
        }

        const existingCount = await this.prisma.userCard.count({ where: { userId } });
        return this.prisma.userCard.create({
            data: {
                userId,
                last4: cardDetails.last4,
                brand: cardDetails.brand ?? 'card',
                expiryMonth: cardDetails.exp_month,
                expiryYear: cardDetails.exp_year,
                stripePaymentMethodId: paymentMethodId,
                isDefault: existingCount === 0,
            },
        });
    }

    async setDefaultCard(userId: string, cardId: string) {
        const card = await this.prisma.userCard.findFirst({
            where: { id: cardId, userId },
        });

        if (!card) {
            throw new NotFoundException('Card not found');
        }

        // Transaction: Unset all others, set this one
        await this.prisma.$transaction([
            this.prisma.userCard.updateMany({
                where: { userId },
                data: { isDefault: false },
            }),
            this.prisma.userCard.update({
                where: { id: cardId },
                data: { isDefault: true },
            }),
        ]);

        return { success: true };
    }
}
