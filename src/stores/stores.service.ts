import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UploadStoreDocumentDto } from './dto/upload-store-document.dto';
import { StoreStatus, OrderStatus } from '@prisma/client';
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
            include: {
                owner: { select: { name: true, email: true, phone: true } },
                documents: true,
                contractAcceptances: {
                    orderBy: { acceptedAt: 'desc' },
                    take: 1
                }
            },
        });

        if (!store) {
            // Auto-create simplified store record if not exists for this Vendor
            let generatedStoreCode = '';
            let isUnique = false;
            while (!isUnique) {
                generatedStoreCode = 'D-' + String(Math.floor(1000 + Math.random() * 9000));
                const existing = await this.prisma.store.findUnique({ where: { storeCode: generatedStoreCode } });
                if (!existing) isUnique = true;
            }

            store = await this.prisma.store.create({
                data: {
                    ownerId: userId,
                    name: 'My New Store',
                    storeCode: generatedStoreCode,
                    status: StoreStatus.PENDING_DOCUMENTS
                },
                include: {
                    owner: { select: { name: true, email: true, phone: true } },
                    documents: true,
                    contractAcceptances: {
                        orderBy: { acceptedAt: 'desc' },
                        take: 1
                    }
                },
            });
        }
        return store;
    }

    async updateMyStore(userId: string, dto: any) {
        const store = await this.findMyStore(userId);
        return this.prisma.store.update({
            where: { id: store.id },
            data: {
                ...dto,
                updatedAt: new Date()
            },
            include: {
                owner: { select: { name: true, email: true, phone: true } },
                documents: true
            }
        });
    }

    async uploadDocument(userId: string, dto: UploadStoreDocumentDto) {
        const store = await this.findMyStore(userId);

        // 1. Check for active business (Orders, Returns, Disputes)
        const activeBusinessCount = await this.prisma.order.count({
            where: {
                storeId: store.id,
                OR: [
                    { status: { in: [OrderStatus.PREPARATION, OrderStatus.SHIPPED] } },
                    { returns: { some: { status: { notIn: ['COMPLETED', 'REJECTED', 'CANCELLED'] } } } },
                    { disputes: { some: { status: { notIn: ['RESOLVED', 'CLOSED'] } } } }
                ]
            }
        });

        if (activeBusinessCount > 0) {
            throw new ForbiddenException('Cannot update documents while you have active orders, returns, or disputes.');
        }

        // 2. Upsert document
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

        // 3. Auto-suspend for legal documents (CR, LICENSE)
        if (dto.docType === 'CR' || dto.docType === 'LICENSE') {
            await this.prisma.store.update({
                where: { id: store.id },
                data: { status: StoreStatus.PENDING_REVIEW }
            });
            
            // Notify merchant
            this.notificationsService.create({
                recipientId: userId,
                recipientRole: 'MERCHANT',
                titleAr: 'تم تعليق الحساب مؤقتاً للمراجعة',
                titleEn: 'Account temporarily suspended for review',
                messageAr: 'لقد قمت بتحديث مستندات قانونية هامة (السجل التجاري أو الرخصة). تم تعليق حسابك مؤقتاً حتى يقوم المسؤول بمراجعة التحديثات وتفعيل المتجر.',
                messageEn: 'You have updated important legal documents (CR or License). Your account is temporarily suspended until an admin reviews the updates.',
                type: 'SYSTEM',
                link: '/dashboard/merchant/store'
            }).catch(e => console.error('Failed to notify merchant of auto-suspension', e));
        }

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
                contractAcceptances: {
                    orderBy: { acceptedAt: 'desc' },
                    take: 1
                },
                orders: { take: 5, orderBy: { createdAt: 'desc' } }, // Brief history
                _count: { select: { orders: true } }
            }
        });
        if (!store) throw new NotFoundException('Store not found');
        return store;
    }
    async updateStatus(id: string, status: StoreStatus, reason?: string) {
        const result = await this.prisma.store.update({
            where: { id },
            data: { 
                status, 
                rejectionReason: status === StoreStatus.REJECTED ? reason : null,
                updatedAt: new Date() 
            },
            include: { owner: true }
        });

        // Bulk Approve Documents if Store is activated
        if (status === StoreStatus.ACTIVE) {
            const nextYear = new Date();
            nextYear.setDate(nextYear.getDate() + 365);
            await this.prisma.storeDocument.updateMany({
                where: { storeId: id, status: 'pending' },
                data: { status: 'approved', expiresAt: nextYear, updatedAt: new Date() }
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

        // Handle Rejection
        if (status === StoreStatus.REJECTED) {
             if (result.ownerId) {
                this.notificationsService.create({
                    recipientId: result.ownerId,
                    recipientRole: 'MERCHANT',
                    titleAr: 'تم رفض طلب إنشاء المتجر',
                    titleEn: 'Store registration request rejected',
                    messageAr: `نأسف لإبلاغك بأنه تم رفض طلبك. السبب: ${reason || 'يرجى مراجعة المستندات والمحاولة مرة أخرى بحساب جديد'}.`,
                    messageEn: `We regret to inform you that your request was rejected. Reason: ${reason || 'Please review documents and try again with a new account'}.`,
                    type: 'SYSTEM',
                    link: '/auth/register'
                }).catch(e => console.error('Failed to send store rejection notification', e));
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

        const dataToUpdate: any = {
            status,
            rejectedReason: reason,
            updatedAt: new Date()
        };

        if (status === 'approved' || status === 'ACTIVE') {
            const nextYear = new Date();
            nextYear.setDate(nextYear.getDate() + 365);
            dataToUpdate.expiresAt = nextYear;
        }

        const updated = await this.prisma.storeDocument.updateMany({
            where: {
                storeId,
                docType: docType as any // Cast to DocType enum
            },
            data: dataToUpdate
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
                OR: [
                    { status: { in: [OrderStatus.PREPARATION, OrderStatus.SHIPPED] } },
                    { returns: { some: { status: { notIn: ['COMPLETED', 'REJECTED', 'CANCELLED'] } } } },
                    { disputes: { some: { status: { notIn: ['RESOLVED', 'CLOSED'] } } } }
                ]
            }
        });

        // Smart alerts for document expiries
        const currentDate = new Date();
        let shouldAutoSuspend = false;

        store.documents.forEach((doc) => {
            if (doc.expiresAt && doc.status === 'approved') {
                const expireDate = new Date(doc.expiresAt);
                const diffTime = expireDate.getTime() - currentDate.getTime();
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                // If passed the 15-day grace period
                if (diffDays < -15) {
                    shouldAutoSuspend = true;
                }
            }
        });

        if (shouldAutoSuspend && ['ACTIVE', 'PENDING_REVIEW'].includes(store.status)) {
            await this.prisma.store.update({
                where: { id: store.id },
                data: { status: StoreStatus.LICENSE_EXPIRED }
            });
            this.notificationsService.create({
                recipientId: store.ownerId,
                recipientRole: 'MERCHANT',
                titleAr: 'إيقاف الحساب بسبب انتهاء المستندات',
                titleEn: 'Account Suspended due to Expired Documents',
                messageAr: `تم إيقاف حسابك لعدم تجديد المستندات الأساسية بعد فترة السماح (15 يوماً). يرجى رفع المستندات المجددة.`,
                messageEn: `Your account has been suspended for not renewing mandatory documents after the 15-day grace period. Please upload renewed documents.`,
                type: 'DOC_EXPIRY',
                link: '/dashboard/merchant/store'
            }).catch(() => {});
        } else {
            // Check for upcoming expiries (30 days or in grace period)
            const warningDocs = store.documents.filter(doc => {
                if (!doc.expiresAt || doc.status !== 'approved') return false;
                const expireDate = new Date(doc.expiresAt);
                const diffDays = Math.ceil((expireDate.getTime() - currentDate.getTime()) / (1000 * 60 * 60 * 24));
                return diffDays <= 30 && diffDays >= -15;
            });
            
            if (warningDocs.length > 0) {
                // Throttle notifications to once a week
                const recentAlert = await this.prisma.notification.findFirst({
                    where: {
                        recipientId: store.ownerId,
                        type: 'DOC_EXPIRY',
                        createdAt: { gte: new Date(currentDate.getTime() - 7 * 24 * 60 * 60 * 1000) }
                    }
                });

                if (!recentAlert) {
                    this.notificationsService.create({
                        recipientId: store.ownerId,
                        recipientRole: 'MERCHANT',
                        titleAr: 'تنبيه مستندات المتجر',
                        titleEn: 'Store Documents Alert',
                        messageAr: `يوجد لديك مستندات تقترب من الإنتهاء أو في فترة السماح. يرجى تحديثها لتجنب إيقاف الحساب.`,
                        messageEn: `You have documents expiring soon or in grace period. Please update them to avoid suspension.`,
                        type: 'DOC_EXPIRY',
                        link: '/dashboard/merchant/store'
                    }).catch(() => {});
                }
            }
        }

        return {
            performance: {
                responseSpeed: 1.5, // Mock realistic average for M1
                prepSpeed: 24, // Mock realistic average for M1
                acceptanceRate,
                rating: Number(store.rating) || 0.0
            },
            weeklyEarnings,
            activeOrdersCount
        };
    }
}
