
import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from './chat.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

@Injectable()
export class ChatService {
    constructor(
        private prisma: PrismaService,
        @Inject(forwardRef(() => ChatGateway))
        private chatGateway: ChatGateway,
        private notificationsService: NotificationsService,
        private auditLogsService: AuditLogsService
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
                vendor: { select: { name: true, logo: true, storeCode: true } },
                customer: { select: { name: true, avatar: true } },
                order: { select: { orderNumber: true, partName: true } },
                messages: { orderBy: { createdAt: 'asc' } }
            }
        });

        if (!fullChat) throw new NotFoundException('Chat not found');
        return this.mapChatToDto(fullChat);
    }

    async getChatById(id: string) {
        const chat = await this.prisma.orderChat.findUnique({
            where: { id },
            include: {
                vendor: { select: { name: true, logo: true, id: true, storeCode: true } },
                customer: { select: { name: true, avatar: true, id: true } },
                order: { select: { orderNumber: true, partName: true, id: true } },
                messages: { orderBy: { createdAt: 'asc' } }
            }
        });
        if (!chat) throw new NotFoundException('Chat not found');
        return this.mapChatToDto(chat);
    }

    async getUserChats(userId: string, role: string, type?: string) {
        let chats = [];
        // Resolve the effective sender ID for unread calculation
        let effectiveSenderId = userId;

        const baseInclude = {
            customer: { select: { name: true, avatar: true } },
            vendor: { select: { name: true, logo: true, storeCode: true } },
            order: { select: { orderNumber: true, partName: true } },
            messages: { 
                where: { isDeletedByAdmin: false },
                orderBy: { createdAt: 'desc' as const }, 
                take: 1 
            },
            _count: { select: { messages: { where: { isRead: false, senderId: { not: userId }, isDeletedByAdmin: false } } } }
        };

        if (role === 'CUSTOMER') {
            chats = await this.prisma.orderChat.findMany({
                where: { customerId: userId, isDeletedByAdmin: false } as any,
                include: baseInclude as any,
                orderBy: { updatedAt: 'desc' }
            });
        } else if (role === 'VENDOR') {
            const store = await this.prisma.store.findUnique({ where: { ownerId: userId } });
            if (!store) return [];
            effectiveSenderId = store.id;

            chats = await this.prisma.orderChat.findMany({
                where: { 
                    OR: [
                        { vendorId: store.id },
                        { customerId: userId, type: 'support' } // Included Merchant-initiated support tickets
                    ],
                    isDeletedByAdmin: false 
                } as any,
                include: baseInclude as any,
                orderBy: { updatedAt: 'desc' }
            });
        } else if (role === 'ADMIN' || role === 'SUPER_ADMIN') {
            // Admin sees chats based on type if provided
            const where: any = { isDeletedByAdmin: false };
            if (type) where.type = type;

            chats = await this.prisma.orderChat.findMany({
                where,
                include: {
                    ...baseInclude,
                    messages: { 
                        orderBy: { createdAt: 'desc' as const }, 
                        take: 1 
                    },
                    _count: { select: { messages: { where: { isRead: false, senderId: { not: userId } } } } }
                } as any,
                orderBy: { updatedAt: 'desc' }
            });
        }

        return chats.map((chat: any) => ({
            ...this.mapChatToDto(chat),
            lastMessage: chat.messages?.[0]?.text || '',
            lastMessageTime: chat.messages?.[0]?.createdAt || chat.updatedAt,
            unreadCount: chat._count?.messages || 0
        }));
    }

    private mapChatToDto(chat: any) {
        return {
            ...chat,
            vendorName: chat.vendor?.name,
            vendorLogo: chat.vendor?.logo,
            vendorCode: chat.vendor?.storeCode, // ADDED
            customerName: chat.customer?.name,
            customerAvatar: chat.customer?.avatar,
            customerCode: chat.customerId ? `CUS-${chat.customerId.substring(0, 6).toUpperCase()}` : undefined, // ADDED
            orderNumber: chat.order?.orderNumber,
            partName: chat.order?.partName,
            // Only keep the messages if they exist (we don't want to map over undefined if not selected)
            messages: chat.messages ? chat.messages : []
        };
    }

    /**
     * Mark all messages in a chat as read for the given user.
     * Only marks messages NOT sent by the user (i.e., incoming messages).
     */
    async markMessagesAsRead(chatId: string, userId: string) {
        const chat = await this.prisma.orderChat.findUnique({ where: { id: chatId } });
        if (!chat) throw new NotFoundException('Chat not found');

        const result = await this.prisma.orderChatMessage.updateMany({
            where: {
                chatId,
                senderId: { not: userId },
                isRead: false,
                isDeletedByAdmin: false
            } as any,
            data: { isRead: true }
        });

        // Broadcast read status to WebSocket room for real-time ✔✔
        if (result.count > 0) {
            try {
                this.chatGateway.server.to(chatId).emit('messagesRead', {
                    chatId,
                    readByUserId: userId,
                    readAt: new Date().toISOString()
                });
            } catch (e) {
                console.error('WebSocket messagesRead broadcast failed', e);
            }
        }

        return { markedCount: result.count };
    }

    async sendMessage(chatId: string, senderId: string | null, text: string, senderRole?: string, mediaUrl?: string, mediaType?: string, mediaName?: string, priority?: string, subject?: string) {
        const chat = await this.prisma.orderChat.findUnique({ 
            where: { id: chatId },
            include: { 
                customer: { select: { name: true } }, 
                vendor: { select: { name: true } } 
            } 
        });
        if (!chat) throw new NotFoundException('Chat not found');

        if (chat.status === 'CLOSED' || chat.status === 'EXPIRED') {
            throw new ForbiddenException(`Chat is ${chat.status}`);
        }

        // --- Chat Guard (Filter) ---
        if (text) {
            let isViolation = false;
            // 1. Regex Pass (Fast)
            const infoRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})|((?:\+|00)\d{1,3}[\s-]*(?:\d[\s-]*){8,15})|(05\d[\s-]*\d[\s-]*\d[\s-]*\d[\s-]*\d[\s-]*\d)|(https?:\/\/[^\s]+)|(www\.[^\s]+)|(wa\.me\/\d+)/i;
            if (infoRegex.test(text)) {
                isViolation = true;
            }

            // 2. AI Pass if Regex is clean (Smart)
            if (!isViolation && process.env.GEMINI_API_KEY) {
                try {
                    const { GoogleGenerativeAI } = require("@google/generative-ai");
                    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
                    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
                    
                    const prompt = `You are a strict chat filter. Your task is to detect if the user is trying to share contact information (phone numbers, emails, website links, or WhatsApp) to bypass the system. 
Check this text: "${text}"
If it contains or attempts to share any contact info (even if obfuscated like 'zero five' or 'my number is'), reply exactly with "VIOLATION". Otherwise, reply exactly with "CLEAN". Do not explain.`;
                    
                    const result = await model.generateContent(prompt);
                    const verdict = result.response.text().trim().toUpperCase();
                    if (verdict.includes("VIOLATION")) {
                        isViolation = true;
                    }
                } catch (e: any) {
                    console.error("AI chat filter failed:", e.message);
                }
            }

            if (isViolation) {
                const actorName = senderRole === 'CUSTOMER' ? chat.customer?.name : (chat.vendor?.name || 'Unknown');
                const actorType = senderRole === 'CUSTOMER' ? 'CUSTOMER' : 'VENDOR';
                await this.auditLogsService.logAction({
                    action: 'CHAT_VIOLATION',
                    entity: 'OrderChat',
                    actorType: actorType as any,
                    actorId: senderId || 'SYSTEM',
                    actorName: actorName || 'Unknown',
                    metadata: { text, chatId, senderRole }
                });

                // Notify all Admins immediately about the violation
                try {
                    const admins = await this.prisma.user.findMany({
                        where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } }
                    });
                    
                    for (const admin of admins) {
                        await this.prisma.notification.create({
                            data: {
                                recipientId: admin.id,
                                recipientRole: admin.role,
                                type: 'CHAT_VIOLATION',
                                titleAr: 'مخالفة فلتر المحادثات 🛡️',
                                titleEn: 'Chat filter violation 🛡️',
                                messageAr: `تم رصد محاولة مشاركة بيانات اتصال من طرف (${actorName}) في المحادثة.`,
                                messageEn: `Detected contact sharing attempt from (${actorName}) in chat.`,
                                metadata: { chatId, text },
                                isRead: false
                            }
                        });
                    }
                } catch (notifError) {
                    console.error('Failed to dispatch Admin notifications:', notifError);
                }

                throw new BadRequestException('CHAT_VIOLATION_DETECTED');
            }
        }
        // --- End Chat Guard ---

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

                // Try multiple valid models starting from newest 2026 models
                const fallbackModels = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest", "gemini-2.5-pro"];
                const prompt = `You are a universal translator for an auto parts marketplace. 
                If the following text is in Arabic, translate it to English. 
                If it is in English, translate it to Arabic. 
                Respond ONLY with the translated text, nothing else. 
                Text: "${text}"`;

                for (const modelName of fallbackModels) {
                    try {
                        const model = genAI.getGenerativeModel({ model: modelName });
                        const result = await model.generateContent(prompt);
                        translatedText = result.response.text().trim();
                        break; // Stop loop on first success
                    } catch (modelError: any) {
                        // If it's a 404, we just continue to the next model. Otherwise, log it.
                        if (modelError?.status === 404 || modelError?.message?.includes('404')) {
                            continue;
                        }
                        console.error(`Gemini Error on ${modelName}:`, modelError.message);
                    }
                }

                if (!translatedText) {
                    console.error("Gemini Translation Error: All fallback models failed or returned 404.");
                }
            } catch (error) {
                console.error("Gemini Translation Setup Error:", error);
                translatedText = null;
            }
        }

        const message = await this.prisma.orderChatMessage.create({
            data: {
                chatId,
                senderId: senderId || undefined,
                text: text || '',
                translatedText,
                mediaUrl,
                mediaType,
                mediaName,
                priority: priority as any,
                subject: subject as any,
                createdAt: messageCreatedAt
            } as any
        });

        // Broadcast to WebSocket clients immediately (0ms latency visual sync)
        try {
            this.chatGateway.broadcastNewMessage(chatId, message);
        } catch (e) {
            console.error('WebSocket dispatch failed', e);
        }

        // Fire & Forget Notifications (Non-blocking) — skip for system messages
        if (senderId) {
            this.dispatchChatNotification(chat, senderId, text).catch(e => {
                console.error('Failed to dispatch chat notification:', e);
            });
        }

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
                    gte: new Date(Date.now() - 3000) // 3 seconds spam block instead of 60 seconds
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
                // Customer -> Admin 
                // Fix: Fetch an actual admin user ID from the DB to satisfy the foreign key constraint.
                const adminUser = await this.prisma.user.findFirst({
                    where: { role: 'ADMIN' },
                    select: { id: true }
                });

                if (!adminUser) return; // Prevent creating notification if NO admin exists

                recipientId = adminUser.id;
                recipientRole = 'ADMIN';
                titleAr = 'رسالة دعم جديدة';
                titleEn = 'New Support Message';
            } else {
                // Admin -> User (Wait, who is the user? Check role)
                const user = await this.prisma.user.findUnique({ where: { id: chat.customerId }, select: { role: true } });
                
                recipientId = chat.customerId;
                recipientRole = user?.role === 'VENDOR' ? 'MERCHANT' : 'CUSTOMER'; 
                titleAr = 'رد جديد من الدعم الفني';
                titleEn = 'New Reply from Support';
            }
        } else {
            // Normal Order Chat: Customer <-> Vendor
            if (senderId === chat.customerId) {
                // Customer -> Vendor
                // IMPORTANT FIX: chat.vendorId is a STORE ID, but Notification recipientId must be a USER ID.
                if (chat.vendorId) {
                    const store = await this.prisma.store.findUnique({
                        where: { id: chat.vendorId },
                        select: { ownerId: true }
                    });
                    if (store) recipientId = store.ownerId;
                }
                recipientRole = 'MERCHANT';
                titleAr = `رسالة من العميل بخصوص طلب ${chat.orderId?.substring(0, 6) || ''}`;
                titleEn = `Message from Customer for Order ${chat.orderId?.substring(0, 6) || ''}`;
            } else if (senderId === chat.vendorId) {
                // Vendor -> Customer (senderId from frontend is sometimes storeId, but we send to customer)
                recipientId = chat.customerId;
                recipientRole = 'CUSTOMER';
                titleAr = `رسالة من التاجر بخصوص طلب ${chat.orderId?.substring(0, 6) || ''}`;
                titleEn = `Message from Merchant for Order ${chat.orderId?.substring(0, 6) || ''}`;
            } else {
                // Fallback if senderId is the actual User ID of the Vendor (Owner) 
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

    async createSupportChat(customerId: string, subject: string, initialMessage: string, orderId?: string, mediaUrl?: string, mediaType?: string, mediaName?: string, priority?: string) {
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
        await this.sendMessage(chat.id, customerId, initialMessage, 'CUSTOMER', mediaUrl, mediaType, mediaName, priority, subject);

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

    /**
     * Admin action: close a chat or block a user from it.
     */
    async adminAction(chatId: string, action: 'close' | 'block' | 'join' | 'deleteChat' | 'deleteMessage' | 'evidence', payload?: any) {
        const chat = await this.prisma.orderChat.findUnique({ 
            where: { id: chatId },
            include: {
                customer: { select: { id: true, name: true, email: true } },
                vendor: { include: { owner: { select: { id: true, name: true, email: true } } } },
                order: true
            }
        });
        if (!chat) throw new NotFoundException('Chat not found');

        switch (action) {
            case 'close':
                await this.prisma.orderChat.update({
                    where: { id: chatId },
                    data: { status: 'CLOSED' }
                });
                this.chatGateway.server.to(chatId).emit('chatStatusChanged', { chatId, status: 'CLOSED', reason: 'Admin closed this conversation' });
                return { success: true, action: 'close' };

            case 'block':
                if (!payload?.userId) throw new BadRequestException('userId required');
                
                // 1. Account-level blocking
                await this.prisma.user.update({
                    where: { id: payload.userId },
                    data: { status: 'BLOCKED' }
                });

                // 2. Chat-level closing
                await this.prisma.orderChat.update({
                    where: { id: chatId },
                    data: { status: 'CLOSED' }
                });
                
                await this.sendMessage(chatId, null, `User has been blocked from the platform by an administrator.`, 'SYSTEM');
                this.chatGateway.server.to(chatId).emit('chatStatusChanged', { chatId, status: 'CLOSED', reason: 'Admin blocked a participant' });
                return { success: true, action: 'block', userId: payload.userId };

            case 'join':
                await this.prisma.orderChat.update({
                    where: { id: chatId },
                    data: { adminJoinedAt: new Date() } as any
                });
                await this.sendMessage(chatId, null, 'An administrator has joined this conversation for monitoring.', 'SYSTEM');
                return { success: true, action: 'join' };

            case 'deleteChat':
                await this.prisma.orderChat.update({
                    where: { id: chatId },
                    data: { isDeletedByAdmin: true } as any
                });
                this.chatGateway.server.to(chatId).emit('chatDeleted', { chatId });
                return { success: true, action: 'deleteChat' };

            case 'deleteMessage':
                if (!payload?.messageId) throw new BadRequestException('messageId required');
                await this.prisma.orderChatMessage.update({
                    where: { id: payload.messageId },
                    data: { isDeletedByAdmin: true } as any
                });
                this.chatGateway.server.to(chatId).emit('messageDeleted', { chatId, messageId: payload.messageId });
                return { success: true, action: 'deleteMessage' };

            case 'evidence':
                const allMessages = await this.prisma.orderChatMessage.findMany({
                    where: { chatId },
                    orderBy: { createdAt: 'asc' }
                });
                return {
                    chatMetadata: {
                        chatId: chat.id,
                        orderId: chat.orderId,
                        orderNumber: (chat.order as any)?.orderNumber,
                        customer: chat.customer,
                        vendor: chat.vendor,
                        createdAt: chat.createdAt,
                        status: chat.status
                    },
                    evidenceSnapshot: allMessages,
                    timestamp: new Date()
                };

            default:
                throw new BadRequestException('Invalid admin action');
        }
    }
}
