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
