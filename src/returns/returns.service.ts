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

        // Notify other parties via Supabase RT (handled by DB trigger or manual broadcast call)
        // Here we just return the message
        return message;
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
            if (order.acceptedOffer?.hasWarranty) {
                // If it's outside the standard 48h but within warranty, it's exchange only
                // However, the spec says "الإرجاع ضمن الضمان -> استبدال فقط"
                // Let's check if the standard 48h has passed but warranty is still active
                const standardWindowMs = 48 * 60 * 60 * 1000;
                const isPastStandard = order.updatedAt < new Date(Date.now() - standardWindowMs);
                if (isPastStandard || reason === 'warranty_claim') {
                    returnType = 'EXCHANGE';
                }
            }

            // Create Return
            const returnRecord = await tx.returnRequest.create({
                data: {
                    orderId: orderId,
                    orderPartId: orderPartId || null,
                    offerId: order.acceptedOffer?.id || null,
                    storeId: order.acceptedOffer?.storeId || null,
                    invoiceId: invoice?.id || null,
                    shipmentId: shipment?.id || null,
                    customerId: userId,
                    reason: reason,
                    description: cleanDescription,
                    usageCondition: usageCondition,
                    returnType: returnType,
                    evidenceFiles: evidenceUrls,
                    status: 'PENDING'
                }
            });

            // Update Order Status
            await tx.order.update({
                where: { id: orderId },
                data: { status: 'RETURN_REQUESTED' }
            });

            return returnRecord;
        });

        // 4. Notify Admin & Merchant (Fire and Forget)
        this.notifyResolutionCenter(orderId, 'RETURN_REQUEST', order.orderNumber).catch(e => console.error('Failed to notify return', e));

        return result;
    }

    async escalateDispute(userId: string, orderId: string, orderPartId: string | undefined, reason: string, description: string, files: Express.Multer.File[]) {
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

            // Create Dispute
            const disputeRecord = await tx.dispute.create({
                data: {
                    orderId: orderId,
                    orderPartId: orderPartId || null,
                    offerId: order.acceptedOffer?.id || null,
                    storeId: order.acceptedOffer?.storeId || null,
                    invoiceId: invoice?.id || null,
                    shipmentId: shipment?.id || null,
                    customerId: userId,
                    reason: reason,
                    description: cleanDescription,
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
        this.notifyResolutionCenter(orderId, 'DISPUTE', order.orderNumber).catch(e => console.error('Failed to notify dispute', e));
        
        // 5. Monitor Merchant Risk Threshold (Spec "تنبيهات")
        if (order.acceptedOffer?.storeId) {
            this.checkMerchantRiskAlert(order.acceptedOffer.storeId).catch(console.error);
        }

        return result;
    }

    private async checkMerchantRiskAlert(storeId: string) {
        const stats = await this.getMerchantRiskStats(storeId);
        if (stats.disputeRate >= 5) {
            await this.notificationsService.create({
                recipientId: 'admin',
                recipientRole: 'ADMIN',
                titleAr: 'تنبيه: معدل نزاعات مرتفع للمتجر',
                titleEn: 'Alert: High Merchant Dispute Rate',
                messageAr: `المتجر تجاوز عتبة الـ 5% (المعدل الحالي: ${stats.disputeRate}%)`,
                messageEn: `The store crossed the 5% threshold (Current rate: ${stats.disputeRate}%)`,
                type: 'ALERT',
                link: `/admin/merchants/${storeId}`
            });
        }
    }

    private async notifyResolutionCenter(orderId: string, type: 'RETURN_REQUEST' | 'DISPUTE', orderNumber: string) {
        // Find Merchant
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: { acceptedOffer: { include: { store: true } } }
        });

        const merchantOwnerId = order?.acceptedOffer?.store?.ownerId;

        const titleAr = type === 'DISPUTE' ? 'نزاع جديد (شكوى)' : 'طلب إرجاع جديد';
        const titleEn = type === 'DISPUTE' ? 'New Dispute Opened' : 'New Return Request';
        const messageAr = type === 'DISPUTE'
            ? `قام العميل برفع شكوى/نزاع بخصوص الطلب #${orderNumber}`
            : `قام العميل بتقديم طلب إرجاع للطلب #${orderNumber}`;
        const messageEn = type === 'DISPUTE'
            ? `Customer opened a dispute for Order #${orderNumber}`
            : `Customer requested a return for Order #${orderNumber}`;

        // Notify global admin
        await this.notificationsService.create({
            recipientId: 'admin',
            recipientRole: 'ADMIN',
            titleAr, titleEn, messageAr, messageEn,
            type: type === 'DISPUTE' ? 'DISPUTE' : 'RETURN',
            link: `/admin/orders/${orderId}`
        });

        // Notify assigned merchant
        if (merchantOwnerId) {
            await this.notificationsService.create({
                recipientId: merchantOwnerId,
                recipientRole: 'MERCHANT',
                titleAr, titleEn, messageAr, messageEn,
                type: type === 'DISPUTE' ? 'DISPUTE' : 'RETURN',
                link: `/dashboard/orders/${orderId}`
            });
        }
    }

    async getUserReturns(userId: string) {
        const [returns, disputes] = await Promise.all([
            this.prisma.returnRequest.findMany({
                where: { customerId: userId },
                include: {
                    order: {
                        include: { parts: true }
                    }
                },
                orderBy: { createdAt: 'desc' }
            }),
            this.prisma.dispute.findMany({
                where: { customerId: userId },
                include: {
                    order: {
                        include: { parts: true }
                    }
                },
                orderBy: { createdAt: 'desc' }
            })
        ]);

        return { returns, disputes };
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
                    order: {
                        acceptedOffer: {
                            storeId: { in: storeIds }
                        }
                    }
                },
                include: {
                    order: { include: { parts: true } },
                    customer: { select: { name: true, phone: true } }
                },
                orderBy: { createdAt: 'desc' }
            }),
            this.prisma.dispute.findMany({
                where: {
                    order: {
                        acceptedOffer: {
                            storeId: { in: storeIds }
                        }
                    }
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

    async respondToReturn(userId: string, returnId: string, action: 'APPROVE' | 'REJECT', responseText: string, files: Express.Multer.File[]) {
        const returnRequest = await this.prisma.returnRequest.findUnique({
            where: { id: returnId },
            include: { 
                order: { 
                    include: { acceptedOffer: { include: { store: true } } } 
                } 
            }
        });

        if (!returnRequest) throw new NotFoundException('Return request not found');
        
        // Ownership Check: User must own the store associated with the order
        if (returnRequest.order.acceptedOffer?.store.ownerId !== userId) {
            throw new ForbiddenException('Access denied - This case does not belong to your store');
        }

        if (returnRequest.status !== 'PENDING') {
            throw new BadRequestException('Response already submitted or case closed');
        }

        // Upload Evidence
        const uploadPromises = (files || []).map(file =>
            this.uploadsService.uploadFile(file, `returns/responses/${returnId}`)
        );
        const evidenceUrls = await Promise.all(uploadPromises);

        const nextStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';

        const result = await this.prisma.$transaction(async (tx) => {
            const updated = await tx.returnRequest.update({
                where: { id: returnId },
                data: {
                    status: nextStatus,
                    updatedAt: new Date(),
                    // We can store merchant response in a new field if we add it to schema, 
                    // for now let's use the description or metadata if available.
                    // Since schema doesn't have merchant_response field yet, I'll log it in Audit and use a metadata JSON if I can.
                }
            });

            // If approved, update order status to facilitate next steps (Waybill etc)
            if (action === 'APPROVE') {
                await tx.order.update({
                    where: { id: returnRequest.orderId },
                    data: { status: 'RETURN_APPROVED' }
                });
            }

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
                    metadata: { evidence: evidenceUrls }
                }
            });

            return updated;
        });

        // Notify Customer
        await this.notificationsService.create({
            recipientId: returnRequest.customerId,
            recipientRole: 'CUSTOMER',
            titleAr: action === 'APPROVE' ? 'تم قبول طلب الإرجاع' : 'تم رفض طلب الإرجاع',
            titleEn: action === 'APPROVE' ? 'Return Request Approved' : 'Return Request Rejected',
            messageAr: `قام المتجر بالرد على طلب الإرجاع للطلب #${returnRequest.order.orderNumber}: ${responseText}`,
            messageEn: `The store responded to your return request for Order #${returnRequest.order.orderNumber}: ${responseText}`,
            type: 'RETURN',
            link: `/orders/${returnRequest.orderId}`
        });

        return result;
    }

    async respondToDispute(userId: string, disputeId: string, responseText: string, files: Express.Multer.File[]) {
        const dispute = await this.prisma.dispute.findUnique({
            where: { id: disputeId },
            include: { 
                order: { 
                    include: { acceptedOffer: { include: { store: true } } } 
                } 
            }
        });

        if (!dispute) throw new NotFoundException('Dispute not found');
        
        if (dispute.order.acceptedOffer?.store.ownerId !== userId) {
            throw new ForbiddenException('Access denied');
        }

        if (dispute.status !== 'OPEN') {
            throw new BadRequestException('Dispute is already being reviewed or closed');
        }

        const uploadPromises = (files || []).map(file =>
            this.uploadsService.uploadFile(file, `disputes/responses/${disputeId}`)
        );
        const evidenceUrls = await Promise.all(uploadPromises);

        const result = await this.prisma.$transaction(async (tx) => {
            const updated = await tx.dispute.update({
                where: { id: disputeId },
                data: {
                    status: 'UNDER_REVIEW',
                    updatedAt: new Date()
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
                    newState: 'UNDER_REVIEW',
                    reason: responseText,
                    metadata: { evidence: evidenceUrls }
                }
            });

            return updated;
        });

        // Notify Admin that merchant has responded and it's ready for review
        await this.notificationsService.create({
            recipientId: 'admin',
            recipientRole: 'ADMIN',
            titleAr: 'رد التاجر على نزاع',
            titleEn: 'Merchant Responded to Dispute',
            messageAr: `قام التاجر بتقديم رد وأدلة للنزاع الخاص بالطلب #${dispute.order.orderNumber}`,
            messageEn: `The merchant provided a response and evidence for the dispute on Order #${dispute.order.orderNumber}`,
            type: 'DISPUTE',
            link: `/admin/disputes/${disputeId}`
        });

        return result;
    }

    // --- Admin Methods ---

    async getAdminCases() {
        const [returns, disputes] = await Promise.all([
            this.prisma.returnRequest.findMany({
                include: {
                    order: { include: { parts: true, acceptedOffer: { include: { store: true } } } },
                    customer: { select: { name: true, phone: true } }
                },
                orderBy: { createdAt: 'desc' }
            }),
            this.prisma.dispute.findMany({
                include: {
                    order: { include: { parts: true, acceptedOffer: { include: { store: true } } } },
                    customer: { select: { name: true, phone: true } }
                },
                orderBy: { createdAt: 'desc' }
            })
        ]);

        return { returns, disputes };
    }

    async issueVerdict(adminId: string, caseId: string, type: 'return' | 'dispute', verdict: 'REFUND' | 'RELEASE_FUNDS' | 'DENY', notes: string, extra?: any) {
        const model = type === 'return' ? this.prisma.returnRequest : this.prisma.dispute;
        
        const caseRecord = await (model as any).findUnique({
            where: { id: caseId },
            include: { order: true }
        });

        if (!caseRecord) throw new NotFoundException('Case not found');

        const nextStatus = verdict === 'REFUND' ? 'REFUNDED' : 'RESOLVED';
        const orderStatus = verdict === 'REFUND' ? 'REFUNDED' : 'COMPLETED';

        const result = await this.prisma.$transaction(async (tx) => {
            const updateData: any = {
                status: nextStatus,
                updatedAt: new Date(),
                verdictNotes: notes
            };

            // Phase 4 Governance Extensions
            if (type === 'dispute' && extra) {
                updateData.faultParty = extra.faultParty;
                updateData.refundAmount = extra.refundAmount;
                updateData.shippingRefund = extra.shippingRefund;
                updateData.stripeFee = extra.stripeFee;
                updateData.verdictIssuedAt = new Date();
                updateData.verdictLocked = false;
            }

            // Handle Return Approval Special Case (Spec §8, §9)
            if (type === 'return' && verdict === 'REFUND') {
                // Approval implies we issue a Return Waybill
                const handoverDeadline = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days handover (Spec §9)
                updateData.handoverDeadline = handoverDeadline;
                updateData.status = 'APPROVED'; // Transitional status before REFUNDED

                // Create a Floating Waybill (linked to ReturnRequest)
                // We'll need to use the shipping service or create a waybill record
                await (tx as any).shippingWaybill.create({
                    data: {
                        orderId: caseRecord.orderId,
                        orderPartId: caseRecord.orderPartId,
                        storeId: caseRecord.storeId,
                        status: 'RETURN_PENDING',
                        type: 'RETURN',
                        metadata: {
                            returnRequestId: caseId,
                            deadline: handoverDeadline,
                            invoiceId: caseRecord.invoiceId
                        }
                    }
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

        // Notify All
        const recipientIds = [caseRecord.customerId];
        const order = await this.prisma.order.findUnique({
            where: { id: caseRecord.orderId },
            include: { acceptedOffer: { include: { store: true } } }
        });
        if (order?.acceptedOffer?.store.ownerId) {
            recipientIds.push(order.acceptedOffer.store.ownerId);
        }

        for (const recipientId of recipientIds) {
            await this.notificationsService.create({
                recipientId,
                recipientRole: recipientId === caseRecord.customerId ? 'CUSTOMER' : 'MERCHANT',
                titleAr: 'تم إصدار الحكم النهائي في النزاع',
                titleEn: 'Final Verdict Issued on Case',
                messageAr: `تم إغلاق النزاع للطلب #${order?.orderNumber} بقرار: ${verdict}. الملاحظات: ${notes}`,
                messageEn: `Case for Order #${order?.orderNumber} closed with verdict: ${verdict}. Notes: ${notes}`,
                type: 'DISPUTE',
                link: `/orders/${caseRecord.orderId}`
            });
        }

        return result;
    }

    async updateVerdict(adminId: string, caseId: string, type: 'return' | 'dispute', verdict: 'REFUND' | 'RELEASE_FUNDS' | 'DENY', notes: string, extra?: any) {
        const model = type === 'return' ? this.prisma.returnRequest : this.prisma.dispute;
        
        const caseRecord = await (model as any).findUnique({
            where: { id: caseId }
        });

        if (!caseRecord) throw new NotFoundException('Case not found');
        
        if (type === 'dispute') {
            if (caseRecord.verdictLocked) throw new BadRequestException('Verdict is permanently locked');
            
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            if (caseRecord.verdictIssuedAt && caseRecord.verdictIssuedAt < oneDayAgo) {
                // Auto-lock if more than 24h passed
                await this.prisma.dispute.update({ where: { id: caseId }, data: { verdictLocked: true } });
                throw new BadRequestException('Verdict edit window (24h) has expired');
            }
        }

        return this.issueVerdict(adminId, caseId, type, verdict, notes, extra);
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
     * GAP 1: Auto-escalate disputes after 3 days of merchant inaction (Spec §17)
     */
    async checkAutoEscalation() {
        const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

        const openDisputes = await this.prisma.dispute.findMany({
            where: {
                status: 'OPEN',
                createdAt: { lt: threeDaysAgo }
            },
            include: { order: true }
        });

        for (const dispute of openDisputes) {
            await this.prisma.dispute.update({
                where: { id: dispute.id },
                data: { status: 'ESCALATED', updatedAt: new Date() }
            });

            // Notify Admin
            await this.notificationsService.create({
                recipientId: 'admin',
                recipientRole: 'ADMIN',
                titleAr: 'تصعيد تلقائي لنزاع',
                titleEn: 'Auto-Escalation: Dispute',
                messageAr: `تم تصعيد النزاع للطلب #${dispute.order.orderNumber} تلقائياً لعدم رد التاجر خلال 3 أيام.`,
                messageEn: `Dispute for Order #${dispute.order.orderNumber} auto-escalated to admin after 3 days of merchant inaction.`,
                type: 'DISPUTE',
                link: `/admin/disputes/${dispute.id}`
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
                    data: { status: 'CLOSED', updatedAt: new Date() }
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
}
