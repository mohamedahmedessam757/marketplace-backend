import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOfferDto } from './dto/create-offer.dto';
import { StoresService } from '../stores/stores.service';

@Injectable()
export class OffersService {
    constructor(
        private prisma: PrismaService,
        private storesService: StoresService,
    ) { }

    async create(userId: string, createOfferDto: CreateOfferDto) {
        // 1. Get Vendor's Store
        const store = await this.storesService.findMyStore(userId);
        if (!store) {
            throw new NotFoundException('You need a Store to submit offers.');
        }

        // 2. Create Offer
        const offer = await this.prisma.offer.create({
            data: {
                orderId: createOfferDto.orderId,
                storeId: store.id,
                unitPrice: createOfferDto.unitPrice,
                weightKg: createOfferDto.weightKg,
                hasWarranty: createOfferDto.hasWarranty,
                deliveryDays: createOfferDto.deliveryDays,
                condition: createOfferDto.condition,
                notes: createOfferDto.notes,
                offerImage: createOfferDto.offerImage,
                // Shipping Cost Logic could be backend-calculated here or taken from DTO
                // For M1, we'll assume DTO structure handles input, but schema has default 0.
                // Let's rely on basic logic or update schema to accept shippingCost if needed.
                // Schema has shippingCost. Let's calculate simple logic or default:
                shippingCost: 0, // Should be calculated or passed. Assuming 0 for now or add to DTO.
            },
            include: {
                store: { select: { name: true } }
            }
        });

        // 3. Update Order Status to AWAITING_OFFERS (if not already)
        // Actually, status logic might be handled by OrdersService, but here we just ensure flow.

        return offer;
    }

    async findByOrder(orderId: string) {
        return this.prisma.offer.findMany({
            where: { orderId },
            include: {
                store: {
                    select: {
                        id: true,
                        name: true,
                        rating: true,
                        createdAt: true, // "Joined At"
                        _count: { select: { orders: true } }
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });
    }
}
