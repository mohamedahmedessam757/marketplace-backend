import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UploadStoreDocumentDto } from './dto/upload-store-document.dto';
import { StoreStatus } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class StoresService {
    constructor(
        private prisma: PrismaService,
        private notificationsService: NotificationsService
    ) { }

    async findMyStore(userId: string) {
        let store = await this.prisma.store.findFirst({
            where: { ownerId: userId },
            include: { documents: true },
        });

        if (!store) {
            // Auto-create simplified store record if not exists for this Vendor
            // Typically this happens at registration, but lazy-create safety here
            store = await this.prisma.store.create({
                data: {
                    ownerId: userId,
                    name: 'My New Store', // Placeholder, user should update profile
                    status: StoreStatus.PENDING_DOCUMENTS
                },
                include: { documents: true },
            });
        }
        return store;
    }

    async uploadDocument(userId: string, dto: UploadStoreDocumentDto) {
        const store = await this.findMyStore(userId);

        // Upsert document (replace old if exists for same type)
        const doc = await this.prisma.storeDocument.upsert({
            where: { storeId_docType: { storeId: store.id, docType: dto.docType } },
            update: {
                fileUrl: dto.fileUrl,
                status: 'pending',
                updatedAt: new Date(),
            },
            create: {
                storeId: store.id,
                docType: dto.docType,
                fileUrl: dto.fileUrl,
                status: 'pending',
            },
        });

        // Check if all required docs are present (Basic logic: CR, ID, IBAN)
        // If so, update store status to PENDING_REVIEW
        // For M1: Just leaving it as is or PENDING_DOCUMENTS until logic expands

        return doc;
    }
    // --- ADMIN METHODS ---

    async findAll() {
        return this.prisma.store.findMany({
            include: {
                owner: { select: { email: true, name: true } },
                documents: true,
                _count: { select: { orders: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
    }

    async findOne(id: string) {
        const store = await this.prisma.store.findUnique({
            where: { id },
            include: {
                owner: { select: { id: true, email: true, name: true, phone: true } }, // Include owner details
                documents: true,
                orders: { take: 5, orderBy: { createdAt: 'desc' } }, // Brief history
                _count: { select: { orders: true } }
            }
        });
        if (!store) throw new NotFoundException('Store not found');
        return store;
    }
    async updateStatus(id: string, status: StoreStatus) {
        const result = await this.prisma.store.update({
            where: { id },
            data: { status, updatedAt: new Date() },
            include: { owner: true }
        });

        // Bulk Approve Documents if Store is activated
        if (status === 'ACTIVE') {
            await this.prisma.storeDocument.updateMany({
                where: { storeId: id, status: 'pending' },
                data: { status: 'approved', updatedAt: new Date() }
            });

            // Notify Merchant
            if (result.ownerId) {
                this.notificationsService.create({
                    recipientId: result.ownerId,
                    recipientRole: 'MERCHANT',
                    titleAr: 'تم تفعيل متجرك المشترك!',
                    titleEn: 'Your store has been activated!',
                    messageAr: `مبروك! لقد تم مراجعة بيانات الاعتماد واعتمادها بنجاح. يمكنك الآن البدء في تقديم عروض على الطلبات وتلقي الأرباح.`,
                    messageEn: `Congratulations! Your credentials have been successfully reviewed and approved. You can now start placing offers and receiving profits.`,
                    type: 'SYSTEM',
                    link: '/dashboard/merchant/store'
                }).catch(e => console.error('Failed to send store activation notification', e));
            }
        }

        return result;
    }

    async updateDocumentStatus(storeId: string, docType: string, status: string, reason?: string) {
        // Find specific doc by type for this store (using the composite key logic or findFirst)
        // Since schema has @@unique([storeId, docType]), we can use findUnique if Prisma generated it,
        // or findFirst. To be safe given pure string inputs:

        // Map string to Enum if needed, but schema uses enum. 
        // Let's assume input is valid or cast it.

        const updated = await this.prisma.storeDocument.updateMany({
            where: {
                storeId,
                docType: docType as any // Cast to DocType enum
            },
            data: {
                status,
                rejectedReason: reason,
                updatedAt: new Date()
            }
        });

        // Notify if rejected
        if (status === 'rejected' || status === 'REJECTED') {
            const store = await this.prisma.store.findUnique({ where: { id: storeId } });
            if (store && store.ownerId) {
                this.notificationsService.create({
                    recipientId: store.ownerId,
                    recipientRole: 'MERCHANT',
                    titleAr: 'تحديث بخصوص المستندات المرفوعة',
                    titleEn: 'Update regarding your uploaded documents',
                    messageAr: `تم رفض المستند الخاص بك (${docType}) من قبل الإدارة. السبب: ${reason || 'يرجى مراجعة البيانات وإعادة الرفع'}.`,
                    messageEn: `Your document (${docType}) was rejected by the administration. Reason: ${reason || 'Please review and re-upload'}.`,
                    type: 'SYSTEM',
                    link: '/dashboard/merchant/documents'
                }).catch(e => console.error('Failed to notify merchant of explicit rejection', e));
            }
        }

        return updated;
    }

    async getDashboardStats(userId: string) {
        const store = await this.findMyStore(userId);

        // 1. Weekly Earnings (Last 7 days)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
        sevenDaysAgo.setHours(0, 0, 0, 0);

        const recentOrders = await this.prisma.order.findMany({
            where: {
                acceptedOffer: { storeId: store.id },
                status: { in: ['PREPARATION', 'SHIPPED', 'DELIVERED', 'COMPLETED'] },
                updatedAt: { gte: sevenDaysAgo }
            },
            select: {
                updatedAt: true,
                acceptedOffer: { select: { unitPrice: true, shippingCost: true } }
            }
        });

        // Initialize array for exactly 7 days [Day-6, Day-5, ... Today]
        const weeklyEarnings = [0, 0, 0, 0, 0, 0, 0];
        const today = new Date().setHours(0, 0, 0, 0);

        recentOrders.forEach(order => {
            if (order.acceptedOffer) {
                const orderDate = new Date(order.updatedAt).setHours(0, 0, 0, 0);
                const diffTime = today - orderDate;
                const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

                if (diffDays >= 0 && diffDays <= 6) {
                    const idx = 6 - diffDays; // 6 is today, 0 is 6 days ago
                    const net = Number(order.acceptedOffer.unitPrice) + Number(order.acceptedOffer.shippingCost);
                    weeklyEarnings[idx] += net;
                }
            }
        });

        // 2. KPIs
        const totalOffers = await this.prisma.offer.count({ where: { storeId: store.id } });
        const acceptedOffers = await this.prisma.offer.count({ where: { storeId: store.id, status: 'accepted' } });

        const acceptanceRate = totalOffers > 0 ? Math.round((acceptedOffers / totalOffers) * 100) : 0;

        // Active Orders
        const activeOrdersCount = await this.prisma.order.count({
            where: {
                acceptedOffer: { storeId: store.id },
                status: 'PREPARATION'
            }
        });

        return {
            performance: {
                responseSpeed: 1.5, // Mock realistic average for M1
                prepSpeed: 24, // Mock realistic average for M1
                acceptanceRate,
                rating: Number(store.rating) || 5.0
            },
            weeklyEarnings,
            activeOrdersCount
        };
    }
}
