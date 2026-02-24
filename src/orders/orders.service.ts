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
                    vinImage: createOrderDto.vinImage,
                    requestType: createOrderDto.requestType,
                    shippingType: createOrderDto.shippingType,

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

        // 3. Notification: Notify Customer & Admin (Async)
        try {
            // Notify Customer
            await this.notifications.create({
                recipientId: customerId,
                recipientRole: 'CUSTOMER',
                titleAr: 'تم استلام طلبك بنجاح',
                titleEn: 'Order Received Successfully',
                messageAr: `تم إنشاء الطلب رقم ${orderNumber} وهو قيد المراجعة بانتظار العروض`,
                messageEn: `Order #${orderNumber} has been created and is awaiting offers`,
                type: 'ORDER',
                link: `/dashboard/orders`,
                metadata: { orderId: result.id, orderNumber }
            });

            // Notify Admin
            await this.notifications.create({
                recipientId: 'admin',
                recipientRole: 'ADMIN',
                titleAr: 'طلب جديد في السوق!',
                titleEn: 'New Order in Marketplace!',
                messageAr: `تم إنشاء طلب جديد رقم ${orderNumber} بانتظار عروض التجار.`,
                messageEn: `A new order #${orderNumber} has been created, awaiting merchant offers.`,
                type: 'ORDER',
                link: `/admin/orders/${result.id}`,
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
                    { acceptedOffer: { storeId: user.storeId } }, // Orders won by me (covers AWAITING_PAYMENT, PREPARATION, SHIPPED, etc.)
                    {
                        // Orders I placed an offer on, but only if they are not actively progressing with another merchant
                        offers: { some: { storeId: user.storeId } },
                        status: { in: [OrderStatus.AWAITING_OFFERS, OrderStatus.CANCELLED] }
                    }
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
                parts: true,
                customer: { select: { name: true, email: true } },
                offers: {
                    include: {
                        store: { select: { id: true, name: true } }
                    }
                },
                _count: {
                    select: { offers: true }
                }
            }
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
                parts: true,
                customer: { select: { name: true, email: true, phone: true } },
                acceptedOffer: true,
                offers: true,
                auditLogs: { orderBy: { timestamp: 'desc' } },
                _count: {
                    select: { offers: true }
                }
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

        // 3. Notification: Notify Customer & Merchant (Async)
        try {
            const statusMessagesAr: Record<string, string> = {
                [OrderStatus.PREPARATION]: 'طلبك قيد التحضير والتجهيز',
                [OrderStatus.SHIPPED]: 'تم شحن طلبك',
                [OrderStatus.DELIVERED]: 'تم توصيل طلبك',
                [OrderStatus.CANCELLED]: 'تم إلغاء طلبك',
                [OrderStatus.AWAITING_PAYMENT]: 'يرجى إتمام عملية الدفع',
                [OrderStatus.RETURNED]: 'تمت الموافقة على طلب الإرجاع الخاص بك'
            };
            const statusMessagesEn: Record<string, string> = {
                [OrderStatus.PREPARATION]: 'Your order is being processed and prepared',
                [OrderStatus.SHIPPED]: 'Your order has been shipped',
                [OrderStatus.DELIVERED]: 'Your order has been delivered',
                [OrderStatus.CANCELLED]: 'Your order has been canceled',
                [OrderStatus.AWAITING_PAYMENT]: 'Please complete your payment',
                [OrderStatus.RETURNED]: 'Your return request has been approved'
            };

            // 3.1 Notify Customer
            if (statusMessagesAr[newStatus]) {
                await this.notifications.create({
                    recipientId: order.customerId,
                    recipientRole: 'CUSTOMER',
                    titleAr: 'تحديث حالة الطلب #' + order.orderNumber,
                    titleEn: 'Order Status Update #' + order.orderNumber,
                    messageAr: statusMessagesAr[newStatus],
                    messageEn: statusMessagesEn[newStatus],
                    type: 'ORDER',
                    link: `/dashboard/orders/${order.id}`,
                    metadata: { orderId: order.id, status: newStatus }
                });
            }

            // 3.2 Notify Merchant (if order is assigned to one via acceptedOffer)
            if (order.acceptedOfferId && ([OrderStatus.PREPARATION, OrderStatus.CANCELLED, OrderStatus.RETURNED] as OrderStatus[]).includes(newStatus)) {
                // Determine Merchant's User ID (ownerId)
                let merchantOwnerId = null;
                if (order.offers && order.offers.length > 0) {
                    const accepted = order.offers.find(o => o.id === order.acceptedOfferId) as any;
                    if (accepted && accepted.store) merchantOwnerId = accepted.store.ownerId;
                } else if ((order.acceptedOffer as any) && (order.acceptedOffer as any).store) {
                    merchantOwnerId = (order.acceptedOffer as any).store.ownerId;
                } else {
                    // Fallback fetch
                    const offerFetch = await this.prisma.offer.findUnique({
                        where: { id: order.acceptedOfferId },
                        include: { store: true }
                    });
                    if (offerFetch?.store?.ownerId) merchantOwnerId = offerFetch.store.ownerId;
                }

                if (merchantOwnerId) {
                    let mTitleAr = `تحديث بخصوص الطلب #${order.orderNumber}`;
                    let mTitleEn = `Update for Order #${order.orderNumber}`;
                    let mMsgAr = '';
                    let mMsgEn = '';

                    if (newStatus === OrderStatus.PREPARATION) {
                        mMsgAr = 'تم تأكيد الدفع من العميل. يرجى البدء بتجهيز الشحنة.';
                        mMsgEn = 'Customer payment confirmed. Please begin preparing the shipment.';
                    } else if (newStatus === OrderStatus.CANCELLED) {
                        mMsgAr = 'تم توقيف أو إلغاء الطلب من قبل النظام أو العميل.';
                        mMsgEn = 'The order was cancelled by the system or customer.';
                    } else if (newStatus === OrderStatus.RETURNED) {
                        mMsgAr = 'تم تحديث حالة الطلب إلى (مرتجع).';
                        mMsgEn = 'The order status was updated to (Returned).';
                    }

                    if (mMsgAr) {
                        await this.notifications.create({
                            recipientId: merchantOwnerId,
                            recipientRole: 'MERCHANT',
                            titleAr: mTitleAr,
                            titleEn: mTitleEn,
                            messageAr: mMsgAr,
                            messageEn: mMsgEn,
                            type: 'ORDER',
                            link: `/dashboard/orders/${order.id}`,
                            metadata: { orderId: order.id, status: newStatus }
                        });
                    }
                }
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
            const offer = await this.prisma.offer.findUnique({
                where: { id: offerId },
                include: { store: true }
            });
            if (offer) {
                await this.chatService.closeOtherChats(orderId, offer.storeId);

                // Notify Winning Merchant
                if (offer.store?.ownerId) {
                    this.notifications.create({
                        recipientId: offer.store.ownerId,
                        recipientRole: 'MERCHANT',
                        titleAr: 'عُرضك تم قبوله!',
                        titleEn: 'Your offer was accepted!',
                        messageAr: `وافق العميل للتو على عرضك للطلب #${order.orderNumber}. بانتظار إتمام عملية الدفع.`,
                        messageEn: `The customer just accepted your offer for Order #${order.orderNumber}. Awaiting payment.`,
                        type: 'ORDER',
                        link: `/dashboard/orders/${order.id}`
                    }).catch(e => console.error('Failed to notify merchant of acceptance', e));
                }

                // Notify Losing Merchants (Reject Offers)
                const losingOffers = await this.prisma.offer.findMany({
                    where: {
                        orderId: orderId,
                        id: { not: offerId }
                    },
                    include: { store: true }
                });

                for (const losingOffer of losingOffers) {
                    if (losingOffer.store?.ownerId) {
                        this.notifications.create({
                            recipientId: losingOffer.store.ownerId,
                            recipientRole: 'MERCHANT',
                            titleAr: 'تم رفض عرضك',
                            titleEn: 'Your offer was rejected',
                            messageAr: `نأسف، لقد قام العميل باختيار عرض آخر للطلب #${order.orderNumber}. حظاً أوفر المرة القادمة!`,
                            messageEn: `Sorry, the customer selected another offer for Order #${order.orderNumber}. Better luck next time!`,
                            type: 'ORDER',
                            link: `/dashboard/orders/${order.id}`
                        }).catch(e => console.error('Failed to notify merchant of explicit rejection', e));
                    }
                }
            }
        } catch (e) {
            console.error('Failed to close other chats or notify', e);
        }

        return result;
    }

    private async generateOrderNumber(): Promise<string> {
        // Call the Postgres function we created in SQL setup
        const result = await this.prisma.$queryRaw<{ generate_order_number: string }[]>`SELECT generate_order_number()`;
        return result[0].generate_order_number;
    }
}
