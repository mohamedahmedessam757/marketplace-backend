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

    async requestReturn(userId: string, orderId: string, reason: string, description: string, files: Express.Multer.File[]) {
        console.log(`[ReturnsService] Requesting Return for Order: ${orderId} by User: ${userId}`);

        // 1. Validate Order Ownership
        const order = await this.prisma.order.findUnique({
            where: { id: orderId }
        });

        if (!order) throw new NotFoundException('Order not found');

        console.log(`[ReturnsService] Order Customer ID: ${order.customerId}`);

        if (order.customerId !== userId) {
            console.error(`[ReturnsService] Ownership Mismatch! Token User: ${userId} !== Order User: ${order.customerId}`);
            throw new ForbiddenException('You do not own this order');
        }

        if (!['DELIVERED', 'SHIPPED'].includes(order.status)) {
            throw new BadRequestException('Order must be delivered or shipped to request a return');
        }

        // 2. Upload Evidence Files (Parallel)
        const uploadPromises = (files || []).map(file =>
            this.uploadsService.uploadFile(file, `returns/${orderId}`)
        );
        const evidenceUrls = await Promise.all(uploadPromises);

        // 3. Create Return Record (Transaction)
        const result = await this.prisma.$transaction(async (tx) => {
            // Create Return
            const returnRecord = await tx.returnRequest.create({
                data: {
                    orderId: orderId,
                    customerId: userId,
                    reason: reason,
                    description: description,
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

    async escalateDispute(userId: string, orderId: string, reason: string, description: string, files: Express.Multer.File[]) {
        console.log(`[ReturnsService] Escalating Dispute for Order: ${orderId} by User: ${userId}`);

        // 1. Validate Order Ownership
        const order = await this.prisma.order.findUnique({
            where: { id: orderId }
        });

        if (!order) throw new NotFoundException('Order not found');

        console.log(`[ReturnsService] Order Customer ID: ${order.customerId}`);

        if (order.customerId !== userId) {
            console.error(`[ReturnsService] Ownership Mismatch! Token User: ${userId} !== Order User: ${order.customerId}`);
            throw new ForbiddenException('You do not own this order');
        }

        // Allow dispute if return was requested or specific conditions met
        // For now, allowing if status is RETURN_REQUESTED or DELIVERED (if immediate dispute)
        // Adjust logic as per business rules. Assuming standard flow: Delivered -> Return -> (if rejected) -> Dispute OR Delivered -> Dispute directly.
        // Let's be permissive and just check ownership for now, or ensure status isn't already closed.
        if (['COMPLETED', 'CANCELLED', 'REFUNDED'].includes(order.status)) {
            throw new BadRequestException('Cannot dispute a closed order');
        }

        // 2. Upload Evidence Files (Parallel)
        const uploadPromises = (files || []).map(file =>
            this.uploadsService.uploadFile(file, `disputes/${orderId}`)
        );
        const evidenceUrls = await Promise.all(uploadPromises);

        // 3. Create Dispute Record (Transaction)
        const result = await this.prisma.$transaction(async (tx) => {
            // Create Dispute
            const disputeRecord = await tx.dispute.create({
                data: {
                    orderId: orderId,
                    customerId: userId,
                    reason: reason,
                    description: description,
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

        return result;
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
}
