import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UploadStoreDocumentDto } from './dto/upload-store-document.dto';
import { StoreStatus } from '@prisma/client';

@Injectable()
export class StoresService {
    constructor(private prisma: PrismaService) { }

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
            data: { status, updatedAt: new Date() }
        });

        // Bulk Approve Documents if Store is activated
        if (status === 'ACTIVE') {
            await this.prisma.storeDocument.updateMany({
                where: { storeId: id, status: 'pending' },
                data: { status: 'approved', updatedAt: new Date() }
            });
        }

        return result;
    }

    async updateDocumentStatus(storeId: string, docType: string, status: string, reason?: string) {
        // Find specific doc by type for this store (using the composite key logic or findFirst)
        // Since schema has @@unique([storeId, docType]), we can use findUnique if Prisma generated it,
        // or findFirst. To be safe given pure string inputs:

        // Map string to Enum if needed, but schema uses enum. 
        // Let's assume input is valid or cast it.

        return this.prisma.storeDocument.updateMany({
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
    }
}
