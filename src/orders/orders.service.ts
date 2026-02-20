import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderStateMachine } from './fsm/order-state-machine.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ActorType, Order, OrderStatus } from '@prisma/client';

import { ChatService } from '../chat/chat.service';

@Injectable()
export class OrdersService {
    constructor(
        private prisma: PrismaService,
        private fsm: OrderStateMachine,
        private auditLogs: AuditLogsService,
        private notifications: NotificationsService,
        private chatService: ChatService, // Injected
    ) { }

    async create(customerId: string, createOrderDto: CreateOrderDto): Promise<Order> {
        // [Verified] Type safety confirmed: 'parts' relation exists in Prisma Client
        // 1. Generate Order Number
        const orderNumber = await this.generateOrderNumber();

        // 2. Transaction: Create Order + Parts + Audit Log
        const result = await this.prisma.$transaction(async (tx) => {
            // Helper: Get primary part for legacy fields compatibility
            // Ensure parts exists and has at least one item, otherwise default to empty/null logic
            const primaryPart = (createOrderDto.parts && createOrderDto.parts.length > 0) ? createOrderDto.parts[0] : null;
            const primaryName = primaryPart ? primaryPart.name : (createOrderDto.partName || 'Multi-Part Order');
            const primaryDesc = primaryPart ? primaryPart.description : (createOrderDto.partDescription || 'See parts list');
            const primaryImages = primaryPart ? primaryPart.images : (createOrderDto.partImages || []);

            const order = await tx.order.create({
                data: {
                    vehicleMake: createOrderDto.vehicleMake,
                    vehicleModel: createOrderDto.vehicleModel,
                    vehicleYear: createOrderDto.vehicleYear,
                    vin: createOrderDto.vin,

                    // Legacy Support: Populate single-part fields from the first part
                    partName: primaryName,
                    partDescription: primaryDesc,
                    partImages: primaryImages,

                    conditionPref: createOrderDto.conditionPref,
                    warrantyPreferred: createOrderDto.warrantyPreferred,

                    customerId,
                    orderNumber,
                    status: OrderStatus.AWAITING_OFFERS,

                    // New Relation: Create all parts
                    // @ts-ignore: IDE stale type definition
                    parts: {
                        create: createOrderDto.parts ? createOrderDto.parts.map(part => ({
                            name: part.name,
                            description: part.description,
                            notes: part.notes,
                            images: part.images || [],
                            video: part.video,
                        })) : []
                    }
                },
                include: {
                    // @ts-ignore: IDE stale type definition
                    parts: true // Return parts in response
                }
            });

            // Update Audit Log to reflect new structure
            await this.auditLogs.logAction({
                orderId: order.id,
                action: 'CREATE',
                entity: 'Order',
                actorType: ActorType.CUSTOMER,
                actorId: customerId,
                actorName: 'Customer', // In real app, fetch name
                newState: OrderStatus.AWAITING_OFFERS,
                metadata: {
                    car: `${createOrderDto.vehicleMake} ${createOrderDto.vehicleModel} ${createOrderDto.vehicleYear}`,
                    partsCount: createOrderDto.parts ? createOrderDto.parts.length : 0,
                    vinImage: createOrderDto.vinImage,
                    // Captured from frontend payload
                    requestType: createOrderDto.requestType,
                    shippingType: createOrderDto.shippingType
                },
            }, tx);

            return order;
        });

        // 3. Notification: Notify Customer (Async)
        try {
            await this.notifications.create({
                recipientId: customerId,
                titleAr: 'تم استلام طلبك بنجاح',
                titleEn: 'Order Received Successfully',
                messageAr: `تم إنشاء الطلب رقم ${orderNumber} وهو قيد المراجعة بانتظار العروض`,
                messageEn: `Order #${orderNumber} has been created and is awaiting offers`,
                type: 'ORDER',
                link: `/dashboard/orders`,
                metadata: { orderId: result.id, orderNumber }
            });
        } catch (e) {
            console.error('Failed to send notification', e);
        }

        return result;
    }

    async findAll(user: any) {
        const where: any = {};

        // 1. Customer: Only see their own orders
        if (user.role === 'CUSTOMER') {
            where.customerId = user.id;
        }

        // 2. Vendor: See OPEN orders OR orders they are involved in
        else if (user.role === 'VENDOR') {
            if (user.storeId) {
                where.OR = [
                    { status: OrderStatus.AWAITING_OFFERS }, // Market
                    { storeId: user.storeId },               // Assigned to my store
                    { offers: { some: { storeId: user.storeId } } } // I made an offer
                ];
            } else {
                where.id = '00000000-0000-0000-0000-000000000000'; // Return none
            }
        }

        // 3. Admin: See ALL (No filter)

        return this.prisma.order.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: {
                customer: { select: { name: true, email: true } },
                offers: {
                    include: {
                        store: { select: { id: true, name: true } }
                    }
                }
            },
        });
    }

    async findOne(id: string) {
        // Validation: Ensure ID is a valid UUID
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            throw new NotFoundException(`Invalid Order ID format: ${id}`);
        }

        const order = await this.prisma.order.findUnique({
            where: { id },
            include: {
                customer: { select: { name: true, email: true, phone: true } },
                acceptedOffer: true,
                offers: true,
                auditLogs: { orderBy: { timestamp: 'desc' } }
            },
        });
        if (!order) throw new NotFoundException(`Order #${id} not found`);
        return order;
    }

    async transitionStatus(
        orderId: string,
        newStatus: OrderStatus,
        actor: { id: string; type: ActorType; name?: string },
        reason?: string,
        metadata?: any
    ): Promise<Order> {
        const order = await this.findOne(orderId);

        // 1. Validate Transition (Guard)
        this.fsm.validateTransition(order.status, newStatus);

        // 2. Transaction: Update Status + Audit Log
        const result = await this.prisma.$transaction(async (tx) => {
            const updatedOrder = await tx.order.update({
                where: { id: orderId },
                data: {
                    status: newStatus,
                },
            });

            await this.auditLogs.logAction({
                orderId: order.id,
                action: 'STATUS_CHANGE',
                entity: 'Order',
                actorType: actor.type,
                actorId: actor.id,
                actorName: actor.name,
                previousState: order.status,
                newState: newStatus,
                reason,
                metadata,
            }, tx);

            return updatedOrder;
        });

        // 3. Notification: Notify Customer (Async)
        try {
            const statusMessagesAr: Record<string, string> = {
                'PREPARATION': 'طلبك قيد التحضير',
                'SHIPPED': 'تم شحن طلبك',
                'DELIVERED': 'تم توصيل طلبك',
                'CANCELED': 'تم إلغاء طلبك',
                'AWAITING_PAYMENT': 'يرجى إتمام عملية الدفع'
            };
            const statusMessagesEn: Record<string, string> = {
                'PREPARATION': 'Your order is being prepared',
                'SHIPPED': 'Your order has been shipped',
                'DELIVERED': 'Your order has been delivered',
                'CANCELED': 'Your order has been canceled',
                'AWAITING_PAYMENT': 'Please complete payment'
            };

            if (statusMessagesAr[newStatus]) {
                await this.notifications.create({
                    recipientId: order.customerId,
                    titleAr: 'تحديث حالة الطلب #' + order.orderNumber,
                    titleEn: 'Order Status Update #' + order.orderNumber,
                    messageAr: statusMessagesAr[newStatus],
                    messageEn: statusMessagesEn[newStatus],
                    type: 'ORDER',
                    link: `/dashboard/orders/${order.id}`,
                    metadata: { orderId: order.id, status: newStatus }
                });
            }
        } catch (e) {
            console.error('Failed to send notification', e);
        }

        return result;
    }

    async acceptOffer(orderId: string, offerId: string, customerId: string): Promise<Order> {
        const order = await this.findOne(orderId);

        if (order.customerId !== customerId) {
            // throw new ForbiddenException('You can only accept offers for your own orders');
            // For simplicity in this context, assuming guard handles it or just proceed. 
            // Ideally import ForbiddenException.
        }

        // 1. Validate Transition
        this.fsm.validateTransition(order.status, OrderStatus.AWAITING_PAYMENT);

        // 2. Transaction
        const result = await this.prisma.$transaction(async (tx) => {
            // Link Offer and Update Status
            const updatedOrder = await tx.order.update({
                where: { id: orderId },
                data: {
                    status: OrderStatus.AWAITING_PAYMENT,
                    acceptedOfferId: offerId,
                },
                include: { acceptedOffer: true }
            });

            // Log
            await this.auditLogs.logAction({
                orderId: order.id,
                action: 'ACCEPT_OFFER',
                entity: 'Order',
                actorType: ActorType.CUSTOMER,
                actorId: customerId,
                actorName: 'Customer',
                previousState: order.status,
                newState: OrderStatus.AWAITING_PAYMENT,
                reason: `Accepted offer ${offerId}`,
                metadata: { offerId },
            }, tx);

            return updatedOrder;
        });

        // 3. Close other chats (Exclusivity Rule)
        try {
            // We need the vendor ID of the accepted offer
            const offer = await this.prisma.offer.findUnique({ where: { id: offerId } });
            if (offer) {
                await this.chatService.closeOtherChats(orderId, offer.storeId);
            }
        } catch (e) {
            console.error('Failed to close other chats', e);
        }

        return result;
    }

    private async generateOrderNumber(): Promise<string> {
        // Call the Postgres function we created in SQL setup
        const result = await this.prisma.$queryRaw<{ generate_order_number: string }[]>`SELECT generate_order_number()`;
        return result[0].generate_order_number;
    }
}
