import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class ReturnsService {
    constructor(
        private prisma: PrismaService,
        private uploadsService: UploadsService,
        private notificationsService: NotificationsService
    ) { }

    // --- Case Messaging (Phase 4) ---

    async addCaseMessage(userId: string, senderRole: string, caseId: string, caseType: 'return' | 'dispute', text: string, attachments: string[]) {
        const message = await this.prisma.caseMessage.create({
            data: {
                caseId,
                caseType,
                senderId: userId,
                senderRole,
                text,
                attachments: attachments || []
            }
        });

        // 2026 Enhanced Notifications: Notify other parties of the new message
        this.notifyMessageParties(userId, senderRole, caseId, caseType, text).catch(e => console.error('Failed to notify message parties', e));

        return message;
    }

    private async notifyMessageParties(senderId: string, senderRole: string, caseId: string, caseType: 'return' | 'dispute', text: string) {
        const model = caseType === 'return' ? this.prisma.returnRequest : this.prisma.dispute;
        const record = await (model as any).findUnique({
            where: { id: caseId },
            include: { order: { include: { acceptedOffer: { include: { store: true } } } } }
        });

        if (!record) return;

        const parties = [
            { id: record.customerId, role: 'CUSTOMER' },
            { id: record.order.acceptedOffer?.store.ownerId, role: 'MERCHANT' }
        ];

        // Notify Admins if sender is not Admin
        if (senderRole !== 'ADMIN' && senderRole !== 'SUPER_ADMIN') {
            await this.notificationsService.notifyAdmins({
                titleAr: `رسالة جديدة: ${caseType === 'dispute' ? 'نزاع' : 'مرتجع'}`,
                titleEn: `New Message: ${caseType.toUpperCase()}`,
                messageAr: `رسالة جديدة من ${senderRole} بخصوص الطلب #${record.order.orderNumber}`,
                messageEn: `New message from ${senderRole} for Order #${record.order.orderNumber}`,
                type: 'MESSAGE',
                link: 'admin-dispute-details',
                metadata: { caseId: caseId }
            });
        }

        // Notify other user/merchant
        for (const party of parties) {
            if (party.id && party.id !== senderId) {
                await this.notificationsService.create({
                    recipientId: party.id,
                    recipientRole: party.role,
                    titleAr: 'رسالة جديدة في النزاع/الإرجاع',
                    titleEn: 'New Resolution Case Message',
                    messageAr: `وصلت رسالة جديدة بخصوص الطلب #${record.order.orderNumber}: ${text.substring(0, 50)}...`,
                    messageEn: `A new message arrived for Order #${record.order.orderNumber}: ${text.substring(0, 50)}...`,
                    type: 'MESSAGE',
                    link: 'dispute-details',
                    metadata: { caseId: caseId }
                });
            }
        }
    }

    private sanitizeInput(text: string): string {
        if (!text) return text;
        // Simple 2026-standard XSS prevention (escaping basic tags)
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private async checkRateLimit(userId: string, type: 'RETURN' | 'DISPUTE') {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const table = type === 'RETURN' ? this.prisma.returnRequest : this.prisma.dispute;
        
        const recentRequest = await (table as any).findFirst({
            where: {
                customerId: userId,
                createdAt: { gte: fiveMinutesAgo }
            }
        });

        if (recentRequest) {
            throw new BadRequestException('Rate limit exceeded. Please wait 5 minutes between requests.');
        }
    }
    async getCaseMessages(userId: string, userRole: string, caseId: string) {
        // SEC-2: Verify the caller is a party to this case or an admin
        if (userRole !== 'ADMIN' && userRole !== 'SUPER_ADMIN' && userRole !== 'SUPPORT') {
            const isParty = await this.prisma.caseMessage.findFirst({
                where: { caseId, senderId: userId }
            });
            // Also check if user is customer or merchant of the case
            const returnCase = await this.prisma.returnRequest.findFirst({ where: { id: caseId, customerId: userId } });
            const disputeCase = await this.prisma.dispute.findFirst({ where: { id: caseId, customerId: userId } });
            if (!isParty && !returnCase && !disputeCase) {
                throw new ForbiddenException('Access denied - You are not a party to this case');
            }
        }

        return await this.prisma.caseMessage.findMany({
            where: { caseId },
            include: { sender: { select: { name: true, avatar: true } } },
            orderBy: { createdAt: 'asc' }
        });
    }

    // --- Merchant Risk Scoring (Phase 4) ---

    async getMerchantRiskStats(storeId: string) {
        const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

        const [totalOrders, totalDisputes] = await Promise.all([
            this.prisma.order.count({
                where: { storeId, createdAt: { gte: ninetyDaysAgo } }
            }),
            this.prisma.dispute.count({
                where: { 
                    order: { storeId },
                    createdAt: { gte: ninetyDaysAgo }
                }
            })
        ]);

        const disputeRate = totalOrders > 0 ? (totalDisputes / totalOrders) * 100 : 0;
        
        return {
            totalOrders,
            totalDisputes,
            disputeRate: parseFloat(disputeRate.toFixed(2)),
            riskLevel: disputeRate > 10 ? 'CRITICAL' : disputeRate > 5 ? 'HIGH' : 'NORMAL'
        };
    }

    async requestReturn(userId: string, orderId: string, orderPartId: string | undefined, reason: string, description: string, usageCondition: string | undefined, files: Express.Multer.File[]) {
        await this.checkRateLimit(userId, 'RETURN');
        const cleanDescription = this.sanitizeInput(description);
        
        console.log(`[ReturnsService] Requesting Return for Order: ${orderId}, Part: ${orderPartId} by User: ${userId}`);

        // 1. Validate Order Ownership and Window
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: { acceptedOffer: true, parts: true }
        });

        if (!order) throw new NotFoundException('Order not found');

        if (order.customerId !== userId) {
            throw new ForbiddenException('You do not own this order');
        }

        if (order.status === 'DELIVERED') {
            const windowMs = 48 * 60 * 60 * 1000;
            if (order.updatedAt < new Date(Date.now() - windowMs)) {
                throw new BadRequestException('Return window (48 hours) has expired for this order');
            }
        } else if (!['SHIPPED', 'DELIVERED'].includes(order.status)) {
            throw new BadRequestException('Order must be delivered or shipped to request a return');
        }

        if (orderPartId) {
            const partExists = order.parts.some(p => p.id === orderPartId);
            if (!partExists) throw new BadRequestException('Invalid Order Part ID');
        }

        // Prevent Duplicate Returns for the same part/order
        const existingReturn = await this.prisma.returnRequest.findFirst({
            where: {
                orderId: orderId,
                orderPartId: orderPartId || null,
                status: { notIn: ['CANCELLED', 'REJECTED'] }
            }
        });

        if (existingReturn) {
            throw new BadRequestException('A return request already exists for this item');
        }

        // 2. Upload Evidence Files (Parallel)
        const uploadPromises = (files || []).map(file =>
            this.uploadsService.uploadFile(file, `returns/${orderId}`)
        );
        const evidenceUrls = await Promise.all(uploadPromises);

        // 3. Create Return Record (Transaction)
        const result = await this.prisma.$transaction(async (tx) => {
            // Find relevant Store, Invoice, and Shipment for linkage
            const invoice = await tx.invoice.findFirst({ where: { orderId: orderId } });
            const shipment = await tx.shipment.findFirst({ where: { orderId: orderId } });

            // Determine if this is a Warranty Return (Exchange Only) Ref: Spec §5
            let returnType = 'REFUND';
            let shouldAutoApprove = false;

            if (order.warranty_end_at && new Date(order.warranty_end_at) > new Date()) {
                // If within warranty period, we prefer replacement
                if (reason === 'warranty_claim' || reason === 'replacement') {
                    returnType = 'EXCHANGE';
                    shouldAutoApprove = true;
                }
            } else if (order.acceptedOffer?.hasWarranty) {
                const standardWindowMs = 48 * 60 * 60 * 1000;
                const isPastStandard = order.updatedAt < new Date(Date.now() - standardWindowMs);
                if (isPastStandard) {
                    returnType = 'EXCHANGE';
                }
            }

            // Resolve relevant Offer & Store
            const acceptedOffer = await tx.offer.findFirst({
                where: {
                    orderId: orderId,
                    ...(orderPartId ? { orderPartId: orderPartId } : {}),
                    status: 'accepted'
                }
            });

            const nextStatus = shouldAutoApprove ? 'APPROVED' : 'PENDING';
            const handoverDeadline = shouldAutoApprove ? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) : null;

            // Create Return
            const returnRecord = await tx.returnRequest.create({
                data: {
                    orderId: orderId,
                    orderPartId: orderPartId || null,
                    offerId: acceptedOffer?.id || order.acceptedOffer?.id || null,
                    storeId: acceptedOffer?.storeId || order.acceptedOffer?.storeId || null,
                    invoiceId: invoice?.id || null,
                    shipmentId: shipment?.id || null,
                    customerId: userId,
                    reason: reason,
                    description: cleanDescription,
                    usageCondition: usageCondition,
                    returnType: returnType,
                    evidenceFiles: evidenceUrls,
                    status: nextStatus,
                    handoverDeadline: handoverDeadline
                }
            });

            // Update Order Status
            await tx.order.update({
                where: { id: orderId },
                data: { status: shouldAutoApprove ? 'RETURN_APPROVED' : 'RETURN_REQUESTED' }
            });

            // If auto-approved, generate waybill immediately
            if (shouldAutoApprove) {
                const store = acceptedOffer?.storeId 
                    ? await tx.store.findUnique({ where: { id: acceptedOffer.storeId } })
                    : await tx.store.findUnique({ where: { id: order.acceptedOffer?.storeId } });

                if (store) {
                    await this.generateReturnWaybill(tx, {
                        order,
                        caseRecord: returnRecord,
                        store,
                        adminId: null, // System auto-approved
                        handoverDeadline: handoverDeadline!
                    });
                }
            }

            return returnRecord;
        });

        // 4. Notify Admin & Merchant (Fire and Forget)
        this.notifyResolutionCenter(orderId, result.id, 'RETURN_REQUEST', order.orderNumber).catch(e => console.error('Failed to notify return', e));

        return result;
    }

    async escalateDispute(userId: string, orderId: string, orderPartId: string | undefined, reason: string, description: string, usageCondition: string | undefined, files: Express.Multer.File[]) {
        await this.checkRateLimit(userId, 'DISPUTE');
        const cleanDescription = this.sanitizeInput(description);

        console.log(`[ReturnsService] Escalating Dispute for Order: ${orderId}, Part: ${orderPartId} by User: ${userId}`);

        // 1. Validate Order Ownership
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: { acceptedOffer: true, parts: true }
        });

        if (!order) throw new NotFoundException('Order not found');

        if (order.customerId !== userId) {
            throw new ForbiddenException('You do not own this order');
        }

        if (order.status === 'DELIVERED') {
            const windowMs = 24 * 60 * 60 * 1000; // Spec §17: 24 hours
            if (order.updatedAt < new Date(Date.now() - windowMs)) {
                throw new BadRequestException('Dispute window (24 hours) has expired for this order');
            }
        } else if (['COMPLETED', 'CANCELLED', 'REFUNDED'].includes(order.status)) {
            throw new BadRequestException('Cannot dispute a closed order');
        }

        if (orderPartId) {
            const partExists = order.parts.some(p => p.id === orderPartId);
            if (!partExists) throw new BadRequestException('Invalid Order Part ID');
        }

        // Prevent Duplicate Disputes for the same part/order
        const existingDispute = await this.prisma.dispute.findFirst({
            where: {
                orderId: orderId,
                orderPartId: orderPartId || null,
                status: { notIn: ['CLOSED', 'RESOLVED'] }
            }
        });

        if (existingDispute) {
            throw new BadRequestException('A dispute already exists for this item');
        }

        // 2. Upload Evidence Files (Parallel)
        const uploadPromises = (files || []).map(file =>
            this.uploadsService.uploadFile(file, `disputes/${orderId}`)
        );
        const evidenceUrls = await Promise.all(uploadPromises);

        // 3. Create Dispute Record (Transaction)
        const result = await this.prisma.$transaction(async (tx) => {
            const invoice = await tx.invoice.findFirst({ where: { orderId: orderId } });
            const shipment = await tx.shipment.findFirst({ where: { orderId: orderId } });

            // Resolve relevant Offer & Store
            const acceptedOffer = await tx.offer.findFirst({
                where: {
                    orderId: orderId,
                    ...(orderPartId ? { orderPartId: orderPartId } : {}),
                    status: 'accepted'
                }
            });

            // Create Dispute
            const disputeRecord = await tx.dispute.create({
                data: {
                    orderId: orderId,
                    orderPartId: orderPartId || null,
                    offerId: acceptedOffer?.id || order.acceptedOffer?.id || null,
                    storeId: acceptedOffer?.storeId || order.acceptedOffer?.storeId || null,
                    invoiceId: invoice?.id || null,
                    shipmentId: shipment?.id || null,
                    customerId: userId,
                    reason: reason,
                    description: cleanDescription,
                    usageCondition: usageCondition,
                    evidenceFiles: evidenceUrls,
                    status: 'OPEN'
                }
            });

            // Update Order Status
            await tx.order.update({
                where: { id: orderId },
                data: { status: 'DISPUTED' }
            });

            return disputeRecord;
        });

        // 4. Notify Admin & Merchant (Fire and Forget)
        this.notifyResolutionCenter(orderId, result.id, 'DISPUTE', order.orderNumber).catch(e => console.error('Failed to notify dispute', e));
        
        // 5. Monitor Merchant Risk Threshold (Spec "تنبيهات")
        if (order.acceptedOffer?.storeId) {
            this.checkMerchantRiskAlert(order.acceptedOffer.storeId).catch(console.error);
        }

        return result;
    }


    private async checkMerchantRiskAlert(storeId: string) {
        const stats = await this.getMerchantRiskStats(storeId);
        if (stats.disputeRate >= 5) {
            await this.notificationsService.notifyAdmins({
                titleAr: 'تنبيه: معدل نزاعات مرتفع للمتجر',
                titleEn: 'Alert: High Merchant Dispute Rate',
                messageAr: `المتجر تجاوز عتبة الـ 5% (المعدل الحالي: ${stats.disputeRate}%)`,
                messageEn: `The store crossed the 5% threshold (Current rate: ${stats.disputeRate}%)`,
                type: 'ALERT',
                link: `/admin/merchants/${storeId}`
            });
        }
    }

    private async notifyResolutionCenter(orderId: string, caseId: string, type: 'RETURN_REQUEST' | 'DISPUTE', orderNumber: string) {
        // Find Merchant/Store Owner
        const store = await this.prisma.store.findFirst({
            where: {
                OR: [
                    { orders: { some: { id: orderId } } },
                    { offers: { some: { orderId: orderId, status: 'accepted' } } }
                ]
            },
            select: { ownerId: true }
        });

        const merchantOwnerId = store?.ownerId;

        const titleAr = type === 'DISPUTE' ? 'نزاع جديد (شكوى)' : 'طلب إرجاع جديد';
        const titleEn = type === 'DISPUTE' ? 'New Dispute Opened' : 'New Return Request';
        const messageAr = type === 'DISPUTE'
            ? `قام العميل برفع شكوى/نزاع بخصوص الطلب #${orderNumber}`
            : `قام العميل بتقديم طلب إرجاع للطلب #${orderNumber}`;
        const messageEn = type === 'DISPUTE'
            ? `Customer opened a dispute for Order #${orderNumber}`
            : `Customer requested a return for Order #${orderNumber}`;

        // Notify global admin
        await this.notificationsService.notifyAdmins({
            titleAr, titleEn, messageAr, messageEn,
            type: type === 'DISPUTE' ? 'DISPUTE' : 'RETURN',
            link: type === 'DISPUTE' ? 'admin-dispute-details' : 'admin-order-details',
            metadata: { orderId: orderId, caseId: caseId }
        });

        // Notify assigned merchant
        if (merchantOwnerId) {
            await this.notificationsService.create({
                recipientId: merchantOwnerId,
                recipientRole: 'MERCHANT',
                titleAr, titleEn, messageAr, messageEn,
                type: type === 'DISPUTE' ? 'DISPUTE' : 'RETURN',
                link: 'resolution', 
                metadata: { orderId: orderId, caseId: caseId }
            });
        }
    }

    async getUserReturns(userId: string) {
        const [returns, disputes] = await Promise.all([
            this.prisma.returnRequest.findMany({
                where: { customerId: userId },
                include: {
                    order: {
                        include: { 
                            parts: true,
                            store: true, // Direct store relation as fallback
                            acceptedOffer: {
                                include: { store: true }
                            },
                            offers: {
                                include: { store: true }
                            },
                            orderChats: {
                                select: { id: true, vendorId: true }
                            }
                        }
                    }
                },
                orderBy: { createdAt: 'desc' }
            }),
            this.prisma.dispute.findMany({
                where: { customerId: userId },
                include: {
                    order: {
                        include: { 
                            parts: true,
                            store: true, // Direct store relation as fallback
                            acceptedOffer: {
                                include: { store: true }
                            },
                            offers: {
                                include: { store: true }
                            },
                            orderChats: {
                                select: { id: true, vendorId: true }
                            }
                        }
                    }
                },
                orderBy: { createdAt: 'desc' }
            })
        ]);

        // Collect missing store IDs to fetch them manually
        const missingStoreIds = [...returns, ...disputes]
            .filter(item => {
                const hasStoreData = item.order?.acceptedOffer?.store || item.order?.store;
                return !hasStoreData && item.storeId;
            })
            .map(item => item.storeId as string);

        const missingOfferIds = [...returns, ...disputes]
            .filter(item => {
                const hasStoreData = item.order?.acceptedOffer?.store || item.order?.store || item.storeId;
                return !hasStoreData && item.offerId;
            })
            .map(item => item.offerId as string);

        const uniqueMissingStoreIds = [...new Set(missingStoreIds)];
        const uniqueMissingOfferIds = [...new Set(missingOfferIds)];
        const missingStoresMap = new Map();

        if (uniqueMissingStoreIds.length > 0) {
            const stores = await this.prisma.store.findMany({
                where: { id: { in: uniqueMissingStoreIds } }
            });
            stores.forEach(s => missingStoresMap.set(s.id, s));
        }

        if (uniqueMissingOfferIds.length > 0) {
            const offers = await this.prisma.offer.findMany({
                where: { id: { in: uniqueMissingOfferIds } },
                include: { store: true }
            });
            // Map the store data using the offer ID so we can retrieve it
            offers.forEach(o => {
                if (o.store) missingStoresMap.set(`offer_${o.id}`, o.store);
            });
        }

        // Map Chat ID and Store data specifically for the accepted merchant or order-linked store
        const mapWithChatId = (items: any[]) => items.map(item => {
            const fallbackFromOffer = item.offerId ? missingStoresMap.get(`offer_${item.offerId}`) : null;
            const fallbackFromStoreId = item.storeId ? missingStoresMap.get(item.storeId) : null;
            const fallbackFromFirstOffer = item.order?.offers?.[0]?.store;
            
            const resolvedFallbackStore = item.order?.acceptedOffer?.store || item.order?.store || fallbackFromFirstOffer || fallbackFromStoreId || fallbackFromOffer;
            
            const acceptedStoreId = resolvedFallbackStore?.id || item.order?.acceptedOffer?.storeId || item.order?.storeId || item.storeId;
            const chat = item.order?.orderChats?.find((c: any) => c.vendorId === acceptedStoreId) || item.order?.orderChats?.[0];
            
            // Enrich the item with fallback store data if acceptedOffer is missing
            return {
                ...item,
                chatId: chat?.id,
                // Ensure store data is bubbled up for the frontend if needed
                fallbackStore: resolvedFallbackStore
            };
        });

        return { 
            returns: mapWithChatId(returns), 
            disputes: mapWithChatId(disputes) 
        };
    }

    async getUserRequests(userId: string) {
        return await this.prisma.returnRequest.findMany({
            where: { customerId: userId },
            include: {
                order: {
                    include: { parts: true }
                }
            },
            orderBy: { createdAt: 'desc' }
        });
    }

    async getUserDisputes(userId: string) {
        return await this.prisma.dispute.findMany({
            where: { customerId: userId },
            include: {
                order: {
                    include: { parts: true }
                }
            },
            orderBy: { createdAt: 'desc' }
        });
    }

    // --- Merchant Methods ---

    async getMerchantCases(userId: string) {
        // 1. Get Store IDs owned by this user
        const stores = await this.prisma.store.findMany({
            where: { ownerId: userId },
            select: { id: true }
        });
        const storeIds = stores.map(s => s.id);

        if (storeIds.length === 0) return { returns: [], disputes: [] };

        // 2. Fetch Returns & Disputes for orders belonging to these stores
        const [returns, disputes] = await Promise.all([
            this.prisma.returnRequest.findMany({
                where: {
                    OR: [
                        { storeId: { in: storeIds } },
                        {
                            order: {
                                acceptedOffer: {
                                    storeId: { in: storeIds }
                                }
                            }
                        }
                    ]
                },
                include: {
                    order: { include: { parts: true } },
                    customer: { select: { name: true, phone: true } }
                },
                orderBy: { createdAt: 'desc' }
            }),
            this.prisma.dispute.findMany({
                where: {
                    OR: [
                        { storeId: { in: storeIds } },
                        {
                            order: {
                                acceptedOffer: {
                                    storeId: { in: storeIds }
                                }
                            }
                        }
                    ]
                },
                include: {
                    order: { include: { parts: true } },
                    customer: { select: { name: true, phone: true } }
                },
                orderBy: { createdAt: 'desc' }
            })
        ]);

        return { returns, disputes };
    }

    async respondToReturn(userId: string, returnId: string, action: 'APPROVE' | 'REJECT', responseText: string, files: Express.Multer.File[], evidenceUrls?: string[]) {
        const returnRequest = await this.prisma.returnRequest.findUnique({
            where: { id: returnId },
            include: { 
                order: { 
                    include: { acceptedOffer: { include: { store: true } } } 
                } 
            }
        });

        if (!returnRequest) throw new NotFoundException('Return request not found');

        // Robust Ownership Check (Aligns with getMerchantCases scopes)
        const merchantStores = await this.prisma.store.findMany({
            where: { ownerId: userId },
            select: { id: true }
        });
        const storeIds = merchantStores.map(s => s.id);
        
        const isOwner = storeIds.includes(returnRequest.storeId) || storeIds.includes(returnRequest.order?.acceptedOffer?.storeId);

        if (!isOwner) {
            throw new ForbiddenException('Access denied - This case does not belong to your store');
        }

        if (returnRequest.status !== 'PENDING') {
            throw new BadRequestException('Response already submitted or case closed');
        }

        // Handle both Multipart Files and Frontend Supabase URLs
        const uploadPromises = (files || []).map(file =>
            this.uploadsService.uploadFile(file, `returns/responses/${returnId}`)
        );
        const serverEvidenceUrls = await Promise.all(uploadPromises);
        const finalEvidenceUrls = [...(evidenceUrls || []), ...serverEvidenceUrls];

        const nextStatus = 'AWAITING_ADMIN';
        const merchantChoice = action; // Recorded as merchant response but status is held

        const result = await this.prisma.$transaction(async (tx) => {
            const updated = await tx.returnRequest.update({
                where: { id: returnId },
                data: {
                    status: nextStatus,
                    updatedAt: new Date(),
                    merchantEvidence: finalEvidenceUrls,
                    merchantResponseText: responseText,
                    merchantDecision: action // Save APPROVE or REJECT
                }
            });

            // Log Audit
            await tx.auditLog.create({
                data: {
                    orderId: returnRequest.orderId,
                    action: 'MERCHANT_RESPONSE',
                    entity: 'RETURN',
                    actorType: 'VENDOR',
                    actorId: userId,
                    previousState: 'PENDING',
                    newState: nextStatus,
                    reason: responseText,
                    metadata: { evidence: finalEvidenceUrls }
                }
            });

            return updated;
        });

        // Notify Customer
        await this.notificationsService.create({
            recipientId: returnRequest.customerId,
            recipientRole: 'CUSTOMER',
            titleAr: 'تحديث في طلب الإرجاع',
            titleEn: 'Return Request Update',
            messageAr: `قام المتجر بالرد على طلب الإرجاع للطلب #${returnRequest.order.orderNumber}. القضية قيد المراجعة الإدارية الآن.`,
            messageEn: `The store responded to your return request for Order #${returnRequest.order.orderNumber}. The case is now awaiting administrative review.`,
            type: 'RETURN',
            link: 'order-details',
            metadata: { orderId: returnRequest.orderId }
        });

        // Notify Admins
        await this.notificationsService.notifyAdmins({
            titleAr: action === 'APPROVE' ? 'تاجر وافق على إرجاع' : 'تاجر رفض إرجاع',
            titleEn: action === 'APPROVE' ? 'Merchant Approved Return' : 'Merchant Rejected Return',
            messageAr: `رد التاجر بـ (${action}) على طلب الإرجاع #${returnRequest.order.orderNumber}`,
            messageEn: `Merchant responded with (${action}) to Return Request #${returnRequest.order.orderNumber}`,
            type: 'RETURN',
            link: 'admin-order-details',
            metadata: { orderId: returnRequest.orderId }
        });

        return result;
    }

    async respondToDispute(userId: string, disputeId: string, responseText: string, files: Express.Multer.File[], evidenceUrls?: string[], action: 'APPROVE' | 'REJECT' = 'REJECT') {
        const dispute = await this.prisma.dispute.findUnique({
            where: { id: disputeId },
            include: { 
                order: { 
                    include: { acceptedOffer: { include: { store: true } } } 
                } 
            }
        });

        if (!dispute) throw new NotFoundException('Dispute not found');

        // Robust Ownership Check
        const merchantStores = await this.prisma.store.findMany({
            where: { ownerId: userId },
            select: { id: true }
        });
        const storeIds = merchantStores.map(s => s.id);
        
        const isOwner = storeIds.includes(dispute.storeId) || storeIds.includes(dispute.order?.acceptedOffer?.storeId);

        if (!isOwner) {
            throw new ForbiddenException('Access denied - This case does not belong to your store');
        }

        if (dispute.status !== 'OPEN') {
            throw new BadRequestException('Dispute is already being reviewed or closed');
        }

        const uploadPromises = (files || []).map(file =>
            this.uploadsService.uploadFile(file, `disputes/responses/${disputeId}`)
        );
        const serverEvidenceUrls = await Promise.all(uploadPromises);
        const finalEvidenceUrls = [...(evidenceUrls || []), ...serverEvidenceUrls];

        const result = await this.prisma.$transaction(async (tx) => {
            const updated = await tx.dispute.update({
                where: { id: disputeId },
                data: {
                    status: 'AWAITING_ADMIN',
                    updatedAt: new Date(),
                    merchantEvidence: finalEvidenceUrls,
                    merchantResponseText: responseText,
                    merchantDecision: action
                }
            });

            await tx.auditLog.create({
                data: {
                    orderId: dispute.orderId,
                    action: 'MERCHANT_DISPUTE_RESPONSE',
                    entity: 'DISPUTE',
                    actorType: 'VENDOR',
                    actorId: userId,
                    previousState: 'OPEN',
                    newState: 'AWAITING_ADMIN',
                    reason: responseText,
                    metadata: { evidence: finalEvidenceUrls }
                }
            });

            return updated;
        });

        await this.notificationsService.notifyAdmins({
            titleAr: 'رد التاجر على نزاع',
            titleEn: 'Merchant Responded to Dispute',
            messageAr: `قام التاجر بتقديم رد وأدلة للنزاع الخاص بالطلب #${dispute.order.orderNumber}`,
            messageEn: `The merchant provided a response and evidence for the dispute on Order #${dispute.order.orderNumber}`,
            type: 'DISPUTE',
            link: `/admin/disputes/${disputeId}`
        });

        // Notify Customer (2026 Real-time Transparency)
        await this.notificationsService.create({
            recipientId: dispute.customerId,
            recipientRole: 'CUSTOMER',
            titleAr: 'تحديث في النزاع القائم',
            titleEn: 'Dispute Case Update',
            messageAr: `قام المتجر بالرد على النزاع #${dispute.order.orderNumber}. بانتظار الحكم النهائي من الإدارة.`,
            messageEn: `The store has responded to Dispute #${dispute.order.orderNumber}. Administrative final verdict is now pending.`,
            type: 'DISPUTE',
            link: 'dispute-details',
            metadata: { caseId: disputeId }
        });

        return result;
    }

    // --- Admin Methods ---

    async getAdminCases() {
        const [returns, disputes] = await Promise.all([
            this.prisma.returnRequest.findMany({
                include: {
                    store: true,
                    order: { 
                        include: { 
                            parts: true, 
                            store: true,
                            acceptedOffer: { include: { store: true } },
                            offers: {
                                where: { status: 'accepted' },
                                include: { store: true },
                                take: 1
                            },
                            auditLogs: { orderBy: { timestamp: 'desc' } }
                        } 
                    },
                    customer: { select: { id: true, name: true, phone: true, avatar: true } }
                },
                orderBy: { createdAt: 'desc' }
            }),
            this.prisma.dispute.findMany({
                include: {
                    store: true,
                    order: { 
                        include: { 
                            parts: true, 
                            store: true,
                            acceptedOffer: { include: { store: true } },
                            offers: {
                                where: { status: 'accepted' },
                                include: { store: true },
                                take: 1
                            },
                            auditLogs: { orderBy: { timestamp: 'desc' } }
                        } 
                    },
                    customer: { select: { id: true, name: true, phone: true, avatar: true } }
                },
                orderBy: { createdAt: 'desc' }
            })
        ]);

        // Guaranteed Merchant Resolver: Inject merchantStore for every case
        const resolveStore = (item: any) => {
            const store = 
                item.store ||                               // 1. Direct storeId on case
                item.order?.acceptedOffer?.store ||        // 2. Accepted offer store
                item.order?.offers?.[0]?.store ||          // 3. First accepted offer store
                item.order?.store ||                       // 4. Order's direct store
                null;
            
            // [DIAGNOSTIC] - REMOVE AFTER FIX
            console.log(`[CASE DIAGNOSTIC] ID: ${item.id} | storeId: ${item.storeId} | resolvedStore: ${store?.name || 'NULL'} | acceptedOffer: ${item.order?.acceptedOffer?.store?.name || 'NONE'} | orderStore: ${item.order?.store?.name || 'NONE'}`);
            
            return { ...item, merchantStore: store };
        };

        return { 
            returns: returns.map(resolveStore), 
            disputes: disputes.map(resolveStore) 
        };
    }

    async issueVerdict(adminId: string, caseId: string, type: 'return' | 'dispute', verdict: 'REFUND' | 'RELEASE_FUNDS' | 'DENY', notes: string, extra?: any) {
        const model = type === 'return' ? this.prisma.returnRequest : this.prisma.dispute;
        
        const caseRecord = await (model as any).findUnique({
            where: { id: caseId },
            include: { 
                store: true,
                offer: true, // 2026 Financial Sync: Fetch the specific offer for price accuracy
                order: {
                    include: {
                        customer: true,
                        acceptedOffer: { include: { store: true } },
                        parts: true,
                        shippingAddresses: true,
                        invoices: true // 2026 Finance: Fetch total paid amount from invoices
                    }
                }
            }
        });

        if (!caseRecord) throw new NotFoundException('Case not found');

        const nextStatus = verdict === 'REFUND' ? 'REFUNDED' : 'RESOLVED';
        const orderStatus = verdict === 'REFUND' ? 'REFUNDED' : 'COMPLETED';

        const result = await this.prisma.$transaction(async (tx) => {
            const updateData: any = {
                status: nextStatus,
                updatedAt: new Date(),
                verdictNotes: notes,
                verdictIssuedAt: new Date(), // 2026 Governance: Always record when verdict is issued
                verdictLocked: true // Lock the verdict by default to prevent unauthorized tampering
            };

            // 2026 Admin Audit Tracking
            console.log(`[ADJUDICATION] Executing verdict for ${type} ${caseId}. Verdict: ${verdict}`);

            // Phase 4 Governance Extensions
            if (extra) {
                // Shared governance fields (exist on BOTH ReturnRequest and Dispute in schema)
                updateData.adminApproval = extra.adminApproval;
                updateData.adminApprovalReason = extra.adminApprovalReason;
                updateData.adminEvidence = extra.adminEvidence || [];
                updateData.adminName = extra.adminName;
                updateData.adminEmail = extra.adminEmail;
                updateData.adminSignature = extra.adminSignature;
                
                // Extended fields for financial breakdown (Refined 2026 Logic)
                updateData.faultParty = extra.faultParty;
                
                // 2026 Financial Automation: If refundAmount is not provided, default to full product cost
                let finalRefundAmount = Number(extra.refundAmount || 0);
                if (verdict === 'REFUND' && finalRefundAmount <= 0) {
                    finalRefundAmount = Number(caseRecord.offer?.unitPrice || caseRecord.order?.acceptedOffer?.unitPrice || 0);
                }
                updateData.refundAmount = finalRefundAmount;

                updateData.shippingRefund = extra.shippingRefund;
                updateData.stripeFee = extra.stripeFee || 0;

                // Phase 1: Shipping Payment Tracking Obligation
                if (extra.faultParty) {
                    // Normalize fault party for systematic processing (2026 Resilient Mapper)
                    const faultLower = String(extra.faultParty || '').toUpperCase();
                    const isMerchantFault = ['STORE', 'MERCHANT', 'VENDOR'].includes(faultLower);
                    const payee = isMerchantFault ? 'MERCHANT' : 'CUSTOMER';
                    updateData.shippingPayee = payee;
                    
                    // If there is a shipping cost, set status to PENDING until paid by the faulty party
                    if (Number(extra.shippingRefund || 0) > 0) {
                        updateData.shippingPaymentStatus = 'PENDING';
                    } else {
                        updateData.shippingPaymentStatus = 'PAID';
                    }
                }
            }

            // Handle Return Approval Special Case (Spec §8, §9)
            if (type === 'return' && verdict === 'REFUND') {
                // Approval implies we issue a Return Waybill
                const handoverDeadline = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days handover (Spec §9)
                updateData.handoverDeadline = handoverDeadline;
                updateData.status = 'APPROVED'; // Transitional status before REFUNDED

                // Extract rich metadata for waybill (Spec §10)
                const order = caseRecord.order;

                // Multi-layer store resolution: acceptedOffer.store → caseRecord.store → DB fallback
                let store = order.acceptedOffer?.store || caseRecord.store;

                // DB fallback: fetch store directly if both above are null
                if (!store && caseRecord.storeId) {
                    store = await tx.store.findUnique({ where: { id: caseRecord.storeId } });
                }

                if (!store) {
                    throw new Error(`[ADJUDICATION] Cannot resolve store for case ${caseId}. storeId: ${caseRecord.storeId}`);
                }

                await this.generateReturnWaybill(tx, {
                    order,
                    caseRecord: { ...caseRecord, ...updateData },
                    store,
                    adminId,
                    handoverDeadline
                });
            }

            const updated = await (tx as any)[type === 'return' ? 'returnRequest' : 'dispute'].update({
                where: { id: caseId },
                data: updateData
            });

            // Status synchronization
            if (type === 'return' && verdict === 'REFUND') {
                await tx.order.update({
                    where: { id: caseRecord.orderId },
                    data: { status: 'RETURN_APPROVED' }
                });
            } else {
                await tx.order.update({
                    where: { id: caseRecord.orderId },
                    data: { status: orderStatus }
                });
            }

            // Audit
            await tx.auditLog.create({
                data: {
                    orderId: caseRecord.orderId,
                    action: 'ADMIN_VERDICT',
                    entity: type.toUpperCase(),
                    actorType: 'ADMIN',
                    actorId: adminId,
                    previousState: caseRecord.status,
                    newState: updateData.status,
                    reason: notes,
                    metadata: { verdict, ...extra }
                }
            });

            return updated;
        });

        // Secure Recipient Resolver (Spec §12)
        const recipientList: { id: string; role: 'CUSTOMER' | 'MERCHANT' }[] = [];
        if (caseRecord.order?.customer?.id) recipientList.push({ id: caseRecord.order.customer.id, role: 'CUSTOMER' });
        
        // Priority: Store on CaseRecord (Direct) -> Store on Order -> Store on AcceptedOffer
        const merchantOwnerId = caseRecord.store?.ownerId || 
                                (caseRecord.order as any).store?.ownerId || 
                                caseRecord.order?.acceptedOffer?.store?.ownerId;
                                
        if (merchantOwnerId) recipientList.push({ id: merchantOwnerId, role: 'MERCHANT' });

        // Verdict Text Mapper (Spec §13 - Human Readable)
        const verdictMap = {
            'REFUND': { ar: 'الموافقة على الإرجاع واسترداد الأموال', en: 'Approved & Refund Issued' },
            'DENY': { ar: 'رفض طلب الإرجاع والإغلاق', en: 'Return Request Denied' },
            'RELEASE_FUNDS': { ar: 'تحرير الأموال للتاجر', en: 'Funds Released to Merchant' }
        };

        const vTextAr = verdictMap[verdict]?.ar || verdict;
        const vTextEn = verdictMap[verdict]?.en || verdict;

        // 2026 High-Performance Execution: Fire-and-forget notifications to avoid blocking admin UI
        // We do NOT await this loop so the HTTP response returns immediately after DB success
        // 2026 High-Performance Execution: Fire-and-forget notifications to avoid blocking admin UI
        recipientList.forEach(recipient => {
            const faultLower = String(extra.faultParty || '').toUpperCase();
            const isMerchantFault = ['STORE', 'MERCHANT', 'VENDOR'].includes(faultLower);
            
            const isPayee = isMerchantFault ? recipient.role === 'MERCHANT' : recipient.role === 'CUSTOMER';
            const shippingCost = Number(extra.shippingRefund || 0);
            
            let finalMessageAr = `تم إغلاق النزاع للطلب #${caseRecord.order?.orderNumber} بقرار: ${vTextAr}. الملاحظات: ${notes}`;
            let finalMessageEn = `Case for Order #${caseRecord.order?.orderNumber} closed with verdict: ${vTextEn}. Notes: ${notes}`;

            if (shippingCost > 0) {
                const faultTextAr = isMerchantFault ? 'التاجر' : 'العميل';
                const faultTextEn = isMerchantFault ? 'Merchant' : 'Customer';
                
                finalMessageAr += `\n\n⚠️ تم تحديد ${faultTextAr} كطرف مسؤول عن تكاليف الشحن بقيمة ${shippingCost} AED.`;
                finalMessageEn += `\n\n⚠️ ${faultTextEn} has been identified as responsible for shipping costs of AED ${shippingCost}.`;

                if (isPayee) {
                    if (recipient.role === 'MERCHANT') {
                        finalMessageAr += `\n\n⛔ تحذير: في حال عدم السداد، ستظل مستحقاتك مجمدة في الموقع وقد يتعرض حسابك للإغلاق. يرجى التوجه لتفاصيل الطلب للسداد.`;
                        finalMessageEn += `\n\n⛔ Warning: If unpaid, your funds will remain frozen and your account may be subject to closure. Please go to Order Details to pay.`;
                    } else {
                        finalMessageAr += `\n\n⛔ تحذير: يرجى سداد تكاليف الشحن لتجنب إغلاق حسابك أو التعرض لغرامات. يرجى التوجه لتفاصيل الطلب للسداد.`;
                        finalMessageEn += `\n\n⛔ Warning: Please pay shipping costs to avoid account closure or fines. Please go to Order Details to pay.`;
                    }
                }
            }

            this.notificationsService.create({
                recipientId: recipient.id,
                recipientRole: recipient.role,
                titleAr: 'تم إصدار الحكم النهائي في النزاع',
                titleEn: 'Final Verdict Issued on Case',
                messageAr: finalMessageAr,
                messageEn: finalMessageEn,
                type: 'DISPUTE',
                link: recipient.role === 'MERCHANT' ? `orders/${caseRecord.orderId}` : `order-details/${caseRecord.orderId}`,
                metadata: { caseId: caseId, isPayee, shippingCost }
            }).catch(err => {
                console.error(`[ASYNC_NOTIFICATION_FAILURE] Failed to notify ${recipient.role} ${recipient.id}: ${err.message}`);
            });
        });

        return result;
    }

    async updateVerdict(adminId: string, caseId: string, type: 'return' | 'dispute', verdict: 'REFUND' | 'RELEASE_FUNDS' | 'DENY', notes: string, extra?: any) {
        const model = type === 'return' ? this.prisma.returnRequest : this.prisma.dispute;
        
        const caseRecord = await (model as any).findUnique({
            where: { id: caseId }
        });

        if (!caseRecord) throw new NotFoundException('Case not found');
        
        if (caseRecord.verdictLocked) throw new BadRequestException('Verdict is permanently locked and cannot be edited');
            
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        if (caseRecord.verdictIssuedAt && caseRecord.verdictIssuedAt < oneDayAgo) {
            // Auto-lock if more than 24h passed
            await (model as any).update({ where: { id: caseId }, data: { verdictLocked: true } });
            throw new BadRequestException('Verdict edit window (24h) has expired');
        }

        return this.issueVerdict(adminId, caseId, type, verdict, notes, extra);
    }

    async manualEscalation(userId: string, caseId: string) {
        // Find in both models
        const [dispute, ret] = await Promise.all([
            this.prisma.dispute.findUnique({
                where: { id: caseId },
                include: { order: { include: { acceptedOffer: { include: { store: true } } } } }
            }),
            this.prisma.returnRequest.findUnique({
                where: { id: caseId },
                include: { order: { include: { acceptedOffer: { include: { store: true } } } } }
            })
        ]);

        const record = dispute || ret;
        const type = dispute ? 'dispute' : 'return';

        if (!record) throw new NotFoundException('Case not found');

        // Authorization check
        const isCustomer = record.customerId === userId;
        const isMerchant = record.order.acceptedOffer?.store.ownerId === userId;
        
        let actorType: 'CUSTOMER' | 'VENDOR' | 'ADMIN' = isCustomer ? 'CUSTOMER' : 'VENDOR';
        let isAuthorized = isCustomer || isMerchant;

        if (!isAuthorized) {
            const user = await this.prisma.user.findUnique({ where: { id: userId } });
            if (user && ['ADMIN', 'SUPER_ADMIN', 'SUPPORT'].includes(user.role)) {
                isAuthorized = true;
                actorType = 'ADMIN';
            }
        }

        if (!isAuthorized) {
            throw new ForbiddenException('Access denied');
        }

        if (record.status === 'RESOLVED' || record.status === 'CLOSED' || record.status === 'ESCALATED') {
            throw new BadRequestException('Case cannot be escalated in its current status');
        }

        const updated = await (this.prisma as any)[type === 'dispute' ? 'dispute' : 'returnRequest'].update({
            where: { id: caseId },
            data: { 
                status: 'ESCALATED',
                updatedAt: new Date()
            }
        });

        // Audit Trail
        await this.prisma.auditLog.create({
            data: {
                orderId: record.orderId,
                action: 'MANUAL_ESCALATION',
                entity: type.toUpperCase(),
                actorType: actorType,
                actorId: userId,
                previousState: record.status,
                newState: 'ESCALATED',
                reason: 'User requested manual escalation to administration'
            }
        });

        // Notify Admins
        await this.notificationsService.notifyAdmins({
            titleAr: `تصعيد يدوي: ${type === 'dispute' ? 'نزاع' : 'مرتجع'}`,
            titleEn: `Manual Escalation: ${type.toUpperCase()}`,
            messageAr: `قام ${isCustomer ? 'العميل' : 'التاجر'} بتصعيد النزاع للطلب #${record.order.orderNumber} يدوياً للإدارة.`,
            messageEn: `${isCustomer ? 'Customer' : 'Merchant'} manually escalated the ${type} for Order #${record.order.orderNumber} to administration.`,
            type: type === 'dispute' ? 'DISPUTE_ESCALATION' : 'RETURN_ESCALATION',
            link: `/dashboard/resolution`
        });

        // Notify the OTHER party
        const otherPartyId = isCustomer ? record.order.acceptedOffer?.store.ownerId : record.customerId;
        const otherPartyRole = isCustomer ? 'MERCHANT' : 'CUSTOMER';
        
        if (otherPartyId) {
            await this.notificationsService.create({
                recipientId: otherPartyId,
                recipientRole: otherPartyRole,
                titleAr: 'تم تصعيد النزاع للإدارة',
                titleEn: 'Case Escalated to Admin',
                messageAr: `تم تصعيد النزاع للطلب #${record.order.orderNumber} رسمياً لمراجعة الإدارة.`,
                messageEn: `The case for Order #${record.order.orderNumber} has been officially escalated for admin review.`,
                type: 'system_alert',
                link: 'dispute-details',
                metadata: { caseId: caseId }
            });
        }

        return updated;
    }

    // --- Customer Risk Scoring (Spec "تنبيهات مهمة") ---

    async getCustomerRiskStats(customerId: string) {
        const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

        const [totalReturns, totalDisputes] = await Promise.all([
            this.prisma.returnRequest.count({
                where: { customerId, createdAt: { gte: ninetyDaysAgo } }
            }),
            this.prisma.dispute.count({
                where: { customerId, createdAt: { gte: ninetyDaysAgo } }
            })
        ]);

        const riskScore = totalReturns * 2 + totalDisputes * 5; // Arbitrary scoring for 2026 intelligence
        
        return {
            totalReturns,
            totalDisputes,
            riskScore,
            riskLevel: riskScore > 15 ? 'CRITICAL' : riskScore > 7 ? 'HIGH' : 'NORMAL'
        };
    }

    // --- Background Tasks (Cron Callable) ---

    /**
     * AUTO-ESCALATION (48H Protection Window)
     * Enforces the mandatory 48-hour response window for merchants.
     * If no response is provided, the case is automatically moved to human administration.
     */
    async checkAutoEscalation() {
        const timeframe = new Date(Date.now() - 48 * 60 * 60 * 1000);

        // 1. Process Pending Return Requests
        const pendingReturns = await this.prisma.returnRequest.findMany({
            where: {
                status: 'PENDING',
                createdAt: { lt: timeframe }
            },
            include: { order: true }
        });

        for (const ret of pendingReturns) {
            await this.prisma.returnRequest.update({
                where: { id: ret.id },
                data: { status: 'ESCALATED', updatedAt: new Date() }
            });

            await this.notificationsService.notifyAdmins({
                titleAr: 'تصعيد تلقائي: طلب إرجاع',
                titleEn: 'Auto-Escalation: Return Request',
                messageAr: `تم تصعيد طلب الإرجاع #${ret.order.orderNumber} لعدم رد التاجر خلال مهلة الـ 48 ساعة.`,
                messageEn: `Return Request #${ret.order.orderNumber} has been auto-escalated; merchant failed to respond within 48h.`,
                type: 'RETURN_ESCALATION',
                link: `/dashboard/resolution`
            });
        }

        // 2. Process Open Disputes
        const openDisputes = await this.prisma.dispute.findMany({
            where: {
                status: 'OPEN',
                createdAt: { lt: timeframe }
            },
            include: { order: true }
        });

        for (const dispute of openDisputes) {
            await this.prisma.dispute.update({
                where: { id: dispute.id },
                data: { status: 'ESCALATED', updatedAt: new Date() }
            });

            await this.notificationsService.notifyAdmins({
                titleAr: 'تصعيد تلقائي: نزاع قائم',
                titleEn: 'Auto-Escalation: Dispute',
                messageAr: `تم تصعيد النزاع للطلب #${dispute.order.orderNumber} لعدم رد التاجر خلال مهلة الـ 48 ساعة.`,
                messageEn: `Dispute for Order #${dispute.order.orderNumber} has been auto-escalated; merchant failed to respond within 48h.`,
                type: 'DISPUTE_ESCALATION',
                link: `/dashboard/resolution`
            });
        }
    }

    /**
     * GAP 3: Auto-cancel approved returns if handover deadline is missed (Spec §9)
     */
    async checkExpiredHandovers() {
        const now = new Date();

        const expiredReturns = await this.prisma.returnRequest.findMany({
            where: {
                status: 'APPROVED',
                handoverDeadline: { lt: now }
            },
            include: { order: true }
        });

        for (const record of expiredReturns) {
            await this.prisma.$transaction(async (tx) => {
                await tx.returnRequest.update({
                    where: { id: record.id },
                    data: { 
                        status: 'CLOSED', 
                        updatedAt: new Date(),
                        verdictIssuedAt: new Date(),
                        verdictLocked: true
                    }
                });

                // Update Order back to COMPLETED or original state? 
                // Spec §9: "يسقط حقه في الإرجاع" -> Means it stays with the customer.
                await tx.order.update({
                    where: { id: record.orderId },
                    data: { status: 'COMPLETED' }
                });

                // Update Waybill to EXPIRED
                await (tx as any).shippingWaybill.updateMany({
                    where: { orderId: record.orderId, status: 'RETURN_PENDING' },
                    data: { status: 'EXPIRED' }
                });
            });

            // Notify Customer
            await this.notificationsService.create({
                recipientId: record.customerId,
                recipientRole: 'CUSTOMER',
                titleAr: 'إلغاء طلب الإرجاع لتجاوز المهلة',
                titleEn: 'Return Cancelled: Deadline Missed',
                messageAr: `تم إلغاء طلب الإرجاع للطلب #${record.order.orderNumber} لتجاوز مهلة الـ 3 أيام المحددة لتسليم القطعة.`,
                messageEn: `Your return request for Order #${record.order.orderNumber} has been cancelled as the 3-day handover deadline was exceeded.`,
                type: 'system_alert',
                link: `/dashboard/orders`
            });
        }
    }



    /**
     * Shared Helper: Generate a Return Waybill
     */
    private async generateReturnWaybill(tx: any, params: { order: any, caseRecord: any, store: any, adminId: string | null, handoverDeadline: Date }) {
        const { order, caseRecord, store, adminId, handoverDeadline } = params;
        const part = (order as any).parts?.find(p => p.id === caseRecord.orderPartId) || (order as any).parts?.[0];

        // Generate Platform-standard Unique Waybill Number (Spec v2026.4)
        const waybillNumber = `RTN-${Math.random().toString(36).substring(2, 7).toUpperCase()}-${Date.now().toString().slice(-4)}`;

        // Sender/Recipient Logic (Swapped for Return Journey)
        // From: Customer -> To: Store
        const shippingAddr = (order as any).shippingAddresses?.[0] || null;
        
        const customerName = shippingAddr?.fullName || shippingAddr?.full_name || order.customer.name || 'Customer';
        const customerPhone = shippingAddr?.phone || order.customer.phone || '';
        const customerAddress = shippingAddr?.details || 'Order Address';
        const customerCity = shippingAddr?.city || (order.customer as any)?.country || '';
        const customerCountry = shippingAddr?.country || (order.customer as any)?.country || '';
        
        // 2026 Financial Hardening: Match original waybill logic (Invoice Total > Unit Price > Order Total)
        const mainInvoice = (order as any).invoices?.[0];
        const invoiceTotal = mainInvoice?.total ? Number(mainInvoice.total) : (mainInvoice?.totalAmount ? Number(mainInvoice.totalAmount) : 0);
        const offerPrice = Number(caseRecord.offer?.unitPrice || 0);
        const acceptedOfferPrice = Number(order.acceptedOffer?.unitPrice || 0);
        const orderTotal = Number(order.totalAmount || 0);
        
        const finalPrice = invoiceTotal > 0 
            ? invoiceTotal 
            : (offerPrice > 0 
                ? offerPrice 
                : (acceptedOfferPrice > 0 ? acceptedOfferPrice : orderTotal));

        // Create a Validated Waybill record
        const waybill = await tx.shippingWaybill.create({
            data: {
                waybillNumber,
                orderId: order.id,
                partId: caseRecord.orderPartId || null,
                storeId: store.id,
                storeName: store.name,
                storeCode: store.storeCode,
                
                // Detailed 2026 Logistics Mapping
                senderName: customerName,
                senderPhone: customerPhone,
                senderAddress: customerAddress,
                senderCity: customerCity,
                senderCountry: customerCountry,

                recipientName: store.name,
                recipientPhone: (store as any).phone || '',
                recipientEmail: (store as any).email || '',
                recipientCity: 'Platform Hub / Store',
                recipientCountry: 'UAE',
                recipientAddress: (store as any).address || 'Verified Store Address',

                customerCode: order.customer.id.substring(0, 8).toUpperCase(),
                partName: part?.name || 'Returned Item',
                partDescription: `RTN-CASE:${caseRecord.id} | Deadline:${handoverDeadline.toISOString()} | Invoice:${caseRecord.invoiceId || 'N/A'}`,
                
                finalPrice,
                
                shippingRefund: caseRecord.shippingRefund, // Round-trip cost transparency
                currency: order.currency || 'AED',
                issuedBy: adminId,
            }
        });

        // 2026 Unified Logistics: Update EXISTING shipment instead of creating a redundant new one
        const existingShipment = await tx.shipment.findFirst({
            where: { 
                orderId: order.id,
                waybill: { partId: caseRecord.orderPartId }
            },
            orderBy: { createdAt: 'desc' }
        });

        const shipmentData = {
            waybillId: waybill.id,
            status: 'RETURN_LABEL_ISSUED' as any,
            carrierName: 'Tashleh Express',
            trackingNumber: waybillNumber,
            statusNotes: `[RETURN] Automated Label Issued. Handover Deadline: ${handoverDeadline.toLocaleDateString()}`
        };

        if (existingShipment) {
            await tx.shipment.update({
                where: { id: existingShipment.id },
                data: shipmentData
            });

            // Create status log for audit trail
            await tx.shipmentStatusLog.create({
                data: {
                    shipmentId: existingShipment.id,
                    fromStatus: existingShipment.status,
                    toStatus: 'RETURN_LABEL_ISSUED' as any,
                    notes: '📄 يتم أصدار بوليصة أرجاع للمنتج',
                    source: 'API'
                }
            });
            console.log(`[SHIPPING] Updated Existing Shipment: ${existingShipment.id} with Return Waybill ${waybillNumber}`);
        } else {
            // Fallback: Check for any shipment for this order
            const anyShipment = await tx.shipment.findFirst({
                where: { orderId: order.id },
                orderBy: { createdAt: 'desc' }
            });

            if (anyShipment) {
                await tx.shipment.update({
                    where: { id: anyShipment.id },
                    data: shipmentData
                });
                await tx.shipmentStatusLog.create({
                    data: {
                        shipmentId: anyShipment.id,
                        fromStatus: anyShipment.status,
                        toStatus: 'RETURN_LABEL_ISSUED' as any,
                        notes: '📄 يتم أصدار بوليصة أرجاع للمنتج',
                        source: 'API'
                    }
                });
            } else {
                // Last resort: Create only if no logistics record exists at all
                await tx.shipment.create({
                    data: {
                        orderId: order.id,
                        ...shipmentData
                    }
                });
            }
        }

        console.log(`[SHIPPING] Generated Return Waybill & Shipment: ${waybillNumber} for Case ${caseRecord.id}`);
    }

    /**
     * 2026 Financial Automation: Deduct shipping cost from wallet balance
     * Triggers logistics state transition and real-time notifications
     */
    async deductShippingFromBalance(userId: string, caseId: string, caseType: 'return' | 'dispute') {
        const modelName = caseType === 'return' ? 'returnRequest' : 'dispute';
        
        return await this.prisma.$transaction(async (tx) => {
            // 1. Fetch Case and Verify Role
            const caseRecord = await (tx as any)[modelName].findUnique({
                where: { id: caseId },
                include: { store: true, order: { include: { customer: true } } }
            });

            if (!caseRecord) throw new NotFoundException('Case not found');
            if (caseRecord.shippingPaymentStatus === 'PAID') throw new BadRequestException('Shipping already paid');
            
            const amount = Number(caseRecord.shippingRefund);
            if (amount <= 0) throw new BadRequestException('Invalid shipping amount');

            // 2. Role-specific Balance Check & Deduction
            let balanceAfter = 0;
            if (caseRecord.shippingPayee === 'MERCHANT') {
                const store = await tx.store.findUnique({ where: { id: caseRecord.storeId } });
                if (!store) throw new NotFoundException('Store not found');
                if (store.ownerId !== userId) throw new BadRequestException('Unauthorized payment');
                
                if (Number(store.balance) < amount) {
                    throw new BadRequestException('Insufficient store balance');
                }

                await tx.store.update({
                    where: { id: store.id },
                    data: { balance: { decrement: amount } }
                });
                balanceAfter = Number(store.balance) - amount;
            } else {
                const user = await tx.user.findUnique({ where: { id: caseRecord.customerId } });
                if (!user) throw new NotFoundException('User not found');
                if (user.id !== userId) throw new BadRequestException('Unauthorized payment');

                if (Number(user.customerBalance) < amount) {
                    throw new BadRequestException('Insufficient rewards balance');
                }

                await tx.user.update({
                    where: { id: user.id },
                    data: { customerBalance: { decrement: amount } }
                });
                balanceAfter = Number(user.customerBalance) - amount;
            }

            // 3. Create Wallet Transaction Log
            await tx.walletTransaction.create({
                data: {
                    userId,
                    role: caseRecord.shippingPayee === 'MERCHANT' ? 'VENDOR' : 'CUSTOMER',
                    type: 'DEBIT',
                    transactionType: 'SHIPPING_FEE',
                    amount: amount,
                    currency: 'AED',
                    description: `Shipping cost for ${caseType} #${caseRecord.orderId} (Wallet Deduction)`,
                    balanceAfter
                }
            });

            // 4. Update Case Status
            const updatedCase = await (tx as any)[modelName].update({
                where: { id: caseId },
                data: {
                    shippingPaymentStatus: 'PAID',
                    shippingPaymentMethod: 'WALLET',
                    updatedAt: new Date()
                }
            });

            // 5. Transition Shipment Status to RETURN_STARTED (بدء الارجاع)
            const shipment = await tx.shipment.findFirst({
                where: { orderId: caseRecord.orderId },
                orderBy: { createdAt: 'desc' }
            });

            if (shipment) {
                await tx.shipment.update({
                    where: { id: shipment.id },
                    data: { status: 'RETURN_STARTED' as any }
                });

                await tx.shipmentStatusLog.create({
                    data: {
                        shipmentId: shipment.id,
                        fromStatus: shipment.status,
                        toStatus: 'RETURN_STARTED' as any,
                        notes: 'بدء الارجاع - تم خصم تكلفة الشحن من المحفظة',
                        source: 'API'
                    }
                });
            }

            // 6. Notify All Parties
            const titleAr = 'تم سداد تكلفة الشحن بنجاح! 💰';
            const titleEn = 'Shipping Paid Successfully! 💰';
            const messageAr = `تم خصم ${amount} AED من محفظتك للطلب #${caseRecord.orderId}. عملية الإرجاع جارية الآن.`;
            const messageEn = `AED ${amount} deducted from your wallet for Order #${caseRecord.orderId}. Return process started.`;

            await this.notificationsService.create({
                recipientId: caseRecord.order.customer.id,
                recipientRole: 'CUSTOMER',
                type: 'ORDER',
                titleAr, titleEn, messageAr, messageEn,
                link: `order-details/${caseRecord.orderId}`,
                metadata: { caseId, caseType }
            });

            const storeOwnerId = (await tx.store.findUnique({ where: { id: caseRecord.storeId }, select: { ownerId: true } })).ownerId;
            await this.notificationsService.create({
                recipientId: storeOwnerId,
                recipientRole: 'VENDOR',
                type: 'ORDER',
                titleAr, titleEn, messageAr, messageEn,
                link: `orders/${caseRecord.orderId}`,
                metadata: { caseId, caseType }
            });

            return updatedCase;
        });
    }
}
