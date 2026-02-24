import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOfferDto } from './dto/create-offer.dto';
import { StoresService } from '../stores/stores.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class OffersService {
    constructor(
        private prisma: PrismaService,
        private storesService: StoresService,
        private notificationsService: NotificationsService,
    ) { }

    async create(userId: string, createOfferDto: CreateOfferDto) {
        // 1. Get Vendor's Store
        const store = await this.storesService.findMyStore(userId);
        if (!store) {
            throw new NotFoundException('You need a Store to submit offers.');
        }

        // 1.5 GUARD: Extreme Validation Check
        const orderInfo = await this.prisma.order.findUnique({
            where: { id: createOfferDto.orderId },
            select: { id: true, status: true, createdAt: true, customerId: true, orderNumber: true }
        });

        if (!orderInfo) {
            throw new NotFoundException('Order not found');
        }

        if (orderInfo.status !== 'AWAITING_OFFERS') {
            throw new BadRequestException('Bidding is closed for this order. Status is no longer AWAITING_OFFERS.');
        }

        const now = new Date().getTime();
        const createdTime = new Date(orderInfo.createdAt).getTime();
        const diffHours = (now - createdTime) / (1000 * 60 * 60);

        if (diffHours >= 24) {
            throw new BadRequestException('Bidding time (24h) has strictly expired for this order.');
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

        // 4. Notify Customer (Fire and Forget)
        if (orderInfo && orderInfo.customerId) {
            this.notificationsService.create({
                recipientId: orderInfo.customerId,
                recipientRole: 'CUSTOMER',
                titleAr: 'عرض سعر جديد!',
                titleEn: 'New Offer Received!',
                messageAr: `قام متجر "${store.name}" بتقديم عرض جديد لطلبك رقم ${orderInfo.orderNumber}`,
                messageEn: `Store "${store.name}" submitted a new offer for your order #${orderInfo.orderNumber}`,
                type: 'OFFER',
                link: `/dashboard/orders/${orderInfo.id}`
            }).catch(e => console.error('Failed to notify customer of new offer', e));
        }

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
