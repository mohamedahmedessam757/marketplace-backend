
import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from './chat.gateway';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class ChatService {
    constructor(
        private prisma: PrismaService,
        @Inject(forwardRef(() => ChatGateway))
        private chatGateway: ChatGateway,
        private notificationsService: NotificationsService
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
                    where: { orderId_vendorId_type: { orderId, vendorId, type: 'order' } }
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
                where: { orderId_vendorId_type: { orderId, vendorId, type: 'order' } }
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
            where: { orderId_vendorId_type: { orderId, vendorId, type: 'order' } }
        });

        if (!chat) {
            // Default expiry matches logic? Or maybe we set static expiry?
            // "If 24h passed ... chat closed" -> implies expiry is at Order.createdAt + 24h
            const expiryDate = new Date(orderCreated.getTime() + 24 * 60 * 60 * 1000);

            chat = await this.prisma.orderChat.create({
                data: {
                    orderId,
                    vendorId,
                    customerId,
                    type: 'order',
                    status: 'OPEN',
                    expiryAt: expiryDate
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

    async getChatById(id: string) {
        const chat = await this.prisma.orderChat.findUnique({
            where: { id },
            include: {
                vendor: { select: { name: true, logo: true } },
                customer: { select: { name: true, avatar: true } },
                order: { select: { orderNumber: true, partName: true } }
            }
        });
        if (!chat) throw new NotFoundException('Chat not found');
        return this.mapChatToDto(chat);
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
        } else if (role === 'ADMIN') {
            chats = await this.prisma.orderChat.findMany({
                where: { type: 'support' },
                include: {
                    customer: { select: { name: true, avatar: true } },
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

    async sendMessage(chatId: string, senderId: string, text: string, senderRole?: string, mediaUrl?: string, mediaType?: string, mediaName?: string) {
        const chat = await this.prisma.orderChat.findUnique({ where: { id: chatId } });
        if (!chat) throw new NotFoundException('Chat not found');

        if (chat.status === 'CLOSED' || chat.status === 'EXPIRED') {
            throw new ForbiddenException(`Chat is ${chat.status}`);
        }

        const messageCreatedAt = new Date();

        // Check if destination user has translation enabled historically before this message
        // For simplicity: If ANY role in this chat has translation enabled PRIOR to this message, we auto-translate it 
        // down to a global En/Ar, handling frontend logic to display it.
        const shouldTranslate = (
            (chat.customerTranslationEnabledAt && chat.customerTranslationEnabledAt <= messageCreatedAt) ||
            (chat.vendorTranslationEnabledAt && chat.vendorTranslationEnabledAt <= messageCreatedAt) ||
            (chat.adminTranslationEnabledAt && chat.adminTranslationEnabledAt <= messageCreatedAt)
        );

        let translatedText = null;
        if (shouldTranslate && text) {
            try {
                const { GoogleGenerativeAI } = require("@google/generative-ai");
                const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

                const prompt = `You are a universal translator for an auto parts marketplace. 
                If the following text is in Arabic, translate it to English. 
                If it is in English, translate it to Arabic. 
                Respond ONLY with the translated text, nothing else. 
                Text: "${text}"`;

                const result = await model.generateContent(prompt);
                translatedText = result.response.text().trim();
            } catch (error) {
                console.error("Gemini Translation Error:", error);
                translatedText = null;
            }
        }

        const message = await this.prisma.orderChatMessage.create({
            data: {
                chatId,
                senderId,
                text: text || '',
                translatedText,
                mediaUrl,
                mediaType,
                mediaName,
                createdAt: messageCreatedAt
            }
        });

        // Broadcast to WebSocket clients immediately (0ms latency visual sync)
        try {
            this.chatGateway.broadcastNewMessage(chatId, message);
        } catch (e) {
            console.error('WebSocket dispatch failed', e);
        }

        // Fire & Forget Notifications (Non-blocking)
        this.dispatchChatNotification(chat, senderId, text).catch(e => {
            console.error('Failed to dispatch chat notification:', e);
        });

        return message;
    }

    private async dispatchChatNotification(chat: any, senderId: string, text: string) {
        let recipientId: string | null = null;
        let recipientRole: string | null = null;
        let titleAr = '';
        let titleEn = '';

        // Spam Protection: Check if there's already an unread notification for this chat recently
        // Simple heuristic: If we notified them in the last 15 minutes, we might skip, 
        // OR we just notify if they have no unread messages from this chat prior to this one.
        // For absolute safety, let's just dispatch the notification if the last message in the DB (excluding this one) was READ, or we just push it if they are offline.
        // To be simpler and safer, we just dispatch the notification via WebSocket/DB. 
        // Real spam protection: we will check if the last message from the same sender was less than 1 minute ago.
        const recentMessages = await this.prisma.orderChatMessage.count({
            where: {
                chatId: chat.id,
                senderId: senderId,
                createdAt: {
                    gte: new Date(Date.now() - 60000) // 1 minute
                }
            }
        });

        if (recentMessages > 1) {
            // Spam block: Only 1 notification per minute per sender for the same chat.
            return;
        }

        if (chat.type === 'support') {
            // Support Chat: Admin <-> Customer
            if (senderId === chat.customerId) {
                // Customer -> Admin (Admin doesn't have a rigid standard notification via DB yet, but we can set it to Admin)
                recipientId = 'admin'; // Assuming 'admin' is handled uniquely
                recipientRole = 'ADMIN';
                titleAr = 'رسالة دعم جديدة';
                titleEn = 'New Support Message';
            } else {
                // Admin -> Customer
                recipientId = chat.customerId;
                recipientRole = 'CUSTOMER';
                titleAr = 'رد جديد من الدعم الفني';
                titleEn = 'New Reply from Support';
            }
        } else {
            // Normal Order Chat: Customer <-> Vendor
            if (senderId === chat.customerId) {
                // Customer -> Vendor
                recipientId = chat.vendorId;
                recipientRole = 'MERCHANT';
                titleAr = `رسالة من العميل بخصوص طلب ${chat.orderId?.substring(0, 6) || ''}`;
                titleEn = `Message from Customer for Order ${chat.orderId?.substring(0, 6) || ''}`;
            } else if (senderId === chat.vendorId) {
                // Vendor -> Customer
                recipientId = chat.customerId;
                recipientRole = 'CUSTOMER';
                titleAr = `رسالة من التاجر بخصوص طلب ${chat.orderId?.substring(0, 6) || ''}`;
                titleEn = `Message from Merchant for Order ${chat.orderId?.substring(0, 6) || ''}`;
            }
        }

        if (recipientId && recipientRole) {
            await this.notificationsService.create({
                recipientId,
                recipientRole,
                titleAr,
                titleEn,
                messageAr: text ? text.substring(0, 50) + '...' : 'مرفق جديد',
                messageEn: text ? text.substring(0, 50) + '...' : 'New Attachment',
                type: 'SYSTEM',
                link: `/dashboard/chats/${chat.id}`
            });
        }
    }

    async toggleTranslation(chatId: string, role: string, enabled: boolean) {
        const data: any = {};
        const timestamp = enabled ? new Date() : null;

        if (role === 'CUSTOMER') data.customerTranslationEnabledAt = timestamp;
        else if (role === 'VENDOR') data.vendorTranslationEnabledAt = timestamp;
        else if (role === 'ADMIN') data.adminTranslationEnabledAt = timestamp;

        return this.prisma.orderChat.update({
            where: { id: chatId },
            data
        });
    }

    async createSupportChat(customerId: string, subject: string, initialMessage: string, orderId?: string, mediaUrl?: string, mediaType?: string, mediaName?: string) {
        // Enforce order validation ONLY if orderId is strictly provided
        if (orderId) {
            const order = await this.prisma.order.findUnique({ where: { id: orderId } });
            if (!order) throw new NotFoundException('Order not found for Support Ticket');
        }

        // Generic tickets are always distinct chats to preserve subject lines logic.
        // For distinctness, we simply create a new ticket (chat).
        const chat = await this.prisma.orderChat.create({
            data: {
                orderId: orderId || null,
                customerId,
                vendorId: null, // No specific vendor for support (internal)
                type: 'support',
                status: 'OPEN',
                expiryAt: null // No SLA expiry for support
            }
        });

        // Add the initial message mapping the subject and content
        await this.sendMessage(chat.id, customerId, `[${subject}] ${initialMessage}`, 'CUSTOMER', mediaUrl, mediaType, mediaName);

        return chat;
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
