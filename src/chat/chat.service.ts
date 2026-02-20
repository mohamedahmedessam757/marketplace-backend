
import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from './chat.gateway';

@Injectable()
export class ChatService {
    constructor(
        private prisma: PrismaService,
        @Inject(forwardRef(() => ChatGateway))
        private chatGateway: ChatGateway
    ) { }

    async createOrGetChat(orderId: string, vendorId: string, customerId: string) {
        // 1. Check if Order exists and requirements
        const order = await this.prisma.order.findUnique({
            where: { id: orderId }
        });
        if (!order) throw new NotFoundException('Order not found');

        // Rule: If an offer is already accepted, ONLY that vendor can chat
        if (order.acceptedOfferId) {
            // Need to check if THIS vendor is the one accepted
            // We can check offer ownership or if we have acceptedOfferId relation to Offer->storeId
            const acceptedOffer = await this.prisma.offer.findUnique({ where: { id: order.acceptedOfferId } });
            if (acceptedOffer && acceptedOffer.storeId !== vendorId) {
                // Return existing chat but maybe marked as CLOSED or throw
                // Per requirement: "Auto-close other chats". So we fetch existing, if closed good, if missing create CLOSED?
                // Let's create it as CLOSED if it's new.
                const existing = await this.prisma.orderChat.findUnique({
                    where: { orderId_vendorId: { orderId, vendorId } }
                });
                if (existing) return existing; // likely closed

                return this.prisma.orderChat.create({
                    data: {
                        orderId, vendorId, customerId, status: 'CLOSED', expiryAt: new Date()
                    }
                });
            }
        }

        // Rule: 24h Expiry check
        // If order creation > 24h && NO accepted offer => Chat Expired
        // Actually the rule says: "If 24h passed and customer didn't choose, chat closed."
        const now = new Date();
        const orderCreated = new Date(order.createdAt);
        const diffHours = (now.getTime() - orderCreated.getTime()) / (1000 * 60 * 60);

        if (diffHours > 24 && !order.acceptedOfferId) {
            const existing = await this.prisma.orderChat.findUnique({
                where: { orderId_vendorId: { orderId, vendorId } }
            });
            if (existing && existing.status !== 'EXPIRED') {
                return this.prisma.orderChat.update({
                    where: { id: existing.id },
                    data: { status: 'EXPIRED' }
                });
            }
            if (!existing) {
                return this.prisma.orderChat.create({
                    data: {
                        orderId, vendorId, customerId, status: 'EXPIRED', expiryAt: new Date()
                    }
                });
            }
            return existing;
        }

        // Normal creation or retrieval
        let chat = await this.prisma.orderChat.findUnique({
            where: { orderId_vendorId: { orderId, vendorId } }
        });

        if (!chat) {
            // Default expiry matches logic? Or maybe we set static expiry?
            // "If 24h passed ... chat closed" -> implies expiry is at Order.createdAt + 24h
            const expiryDate = new Date(orderCreated.getTime() + 24 * 60 * 60 * 1000);

            // [NEW] Feature: Check Customer's Auto-Translate Setting
            let isTranslationEnabled = false;
            try {
                const settings = await this.prisma.userSettings.findUnique({ where: { userId: customerId } });
                if (settings && settings.autoTranslateChat) {
                    isTranslationEnabled = true;
                }
            } catch (e) { }

            chat = await this.prisma.orderChat.create({
                data: {
                    orderId,
                    vendorId,
                    customerId,
                    status: 'OPEN',
                    expiryAt: expiryDate,
                    isTranslationEnabled // Set initial state
                }
            });
        }

        // Refetch to get relations for UI
        const fullChat = await this.prisma.orderChat.findUnique({
            where: { id: chat.id },
            include: {
                vendor: { select: { name: true, logo: true } },
                customer: { select: { name: true, avatar: true } },
                order: { select: { orderNumber: true, partName: true } }
            }
        });

        return this.mapChatToDto(fullChat);
    }

    async getUserChats(userId: string, role: string) {
        let chats = [];
        if (role === 'CUSTOMER') {
            chats = await this.prisma.orderChat.findMany({
                where: { customerId: userId },
                include: {
                    vendor: { select: { name: true, logo: true } },
                    order: { select: { orderNumber: true, partName: true } },
                    messages: { orderBy: { createdAt: 'desc' }, take: 1 }
                },
                orderBy: { updatedAt: 'desc' }
            });
        } else if (role === 'VENDOR') {
            const store = await this.prisma.store.findUnique({ where: { ownerId: userId } });
            if (!store) return [];

            chats = await this.prisma.orderChat.findMany({
                where: { vendorId: store.id },
                include: {
                    customer: { select: { name: true, avatar: true } },
                    vendor: { select: { name: true, logo: true } }, // Include store for consistency
                    order: { select: { orderNumber: true, partName: true } },
                    messages: { orderBy: { createdAt: 'desc' }, take: 1 }
                },
                orderBy: { updatedAt: 'desc' }
            });
        }

        return chats.map(chat => ({
            ...this.mapChatToDto(chat),
            lastMessage: chat.messages?.[0]?.text || '',
            lastMessageTime: chat.messages?.[0]?.createdAt || chat.updatedAt,
            unreadCount: 0 // logic for unread count to be added if table supports it
        }));
    }

    private mapChatToDto(chat: any) {
        return {
            ...chat,
            vendorName: chat.store?.name,
            vendorLogo: chat.store?.logo,
            customerName: chat.customer?.name,
            customerAvatar: chat.customer?.avatar,
            orderNumber: chat.order?.orderNumber,
            partName: chat.order?.partName,
            // Flatten generic messages lastMessage if needed, or handle in loop
        };
    }

    async sendMessage(chatId: string, senderId: string, text: string) {
        const chat = await this.prisma.orderChat.findUnique({ where: { id: chatId } });
        if (!chat) throw new NotFoundException('Chat not found');

        if (chat.status !== 'OPEN') {
            throw new ForbiddenException(`Chat is ${chat.status}`);
        }

        // Logic (Google Gemini Live Translation):
        let translatedText = null;
        if (chat.isTranslationEnabled) {
            try {
                const { GoogleGenerativeAI } = require("@google/generative-ai");
                const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
                // We want the fastest model for chat: gemini-1.5-flash
                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

                // Prompt strictly to translate from Ar <-> En seamlessly
                const prompt = `You are a universal translator for an auto parts marketplace. 
                If the following text is in Arabic, translate it to English. 
                If it is in English, translate it to Arabic. 
                Respond ONLY with the translated text, nothing else. 
                Text: "${text}"`;

                const result = await model.generateContent(prompt);
                translatedText = result.response.text().trim();
            } catch (error) {
                console.error("Gemini Translation Error:", error);
                // Fallback softly to null if quota/error occurs so the chat doesn't break
                translatedText = null;
            }
        }

        const message = await this.prisma.orderChatMessage.create({
            data: {
                chatId,
                senderId,
                text,
                translatedText
            }
        });

        // Broadcast to WebSocket clients immediately (0ms latency visual sync)
        try {
            this.chatGateway.broadcastNewMessage(chatId, message);
        } catch (e) {
            console.error('WebSocket dispatch failed', e);
        }

        return message;
    }

    async toggleTranslation(chatId: string, enabled: boolean) {
        return this.prisma.orderChat.update({
            where: { id: chatId },
            data: { isTranslationEnabled: enabled }
        });
    }

    async closeOtherChats(orderId: string, acceptedVendorId: string) {
        // Called when an Offer is accepted
        await this.prisma.orderChat.updateMany({
            where: {
                orderId: orderId,
                vendorId: { not: acceptedVendorId },
                status: 'OPEN'
            },
            data: { status: 'CLOSED' }
        });
    }
}
