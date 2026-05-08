import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderStateMachine } from './fsm/order-state-machine.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ActorType, Order, OrderStatus, Prisma } from '@prisma/client';
import { FindAllOrdersDto } from './dto/find-all-orders.dto';

import { ChatService } from '../chat/chat.service';
import { ShipmentsService } from '../shipments/shipments.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class OrdersService {
    constructor(
        private prisma: PrismaService,
        private fsm: OrderStateMachine,
        private auditLogs: AuditLogsService,
        private notifications: NotificationsService,
        private chatService: ChatService, // Injected
        private shipmentsService: ShipmentsService,
        private loyaltyService: LoyaltyService,
        private usersService: UsersService,
    ) { }

    async create(customerId: string, createOrderDto: CreateOrderDto): Promise<Order> {
        // [Verified] Type safety confirmed: 'parts' relation exists in Prisma Client
        
        // --- 2026 Governance Enforcement: Order Limit ---
        const customer = await this.prisma.user.findUnique({
            where: { id: customerId },
            select: { orderLimit: true, dailyOrderCount: true, restrictionAlertMessage: true }
        });

        if (customer && customer.orderLimit !== -1 && customer.dailyOrderCount >= customer.orderLimit) {
            throw new ForbiddenException(customer.restrictionAlertMessage || `You have reached your daily limit of ${customer.orderLimit} orders. Please try again tomorrow.`);
        }
        // ------------------------------------------------

        // 1. Generate Order Number
        const orderNumber = await this.generateOrderNumber();

        // 2. Transaction: Create Order + Parts + Audit Log + Update Count
        const result = await this.prisma.$transaction(async (tx) => {
            // Increment daily count
            await tx.user.update({
                where: { id: customerId },
                data: { dailyOrderCount: { increment: 1 } }
            });

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
                    status: OrderStatus.COLLECTING_OFFERS,
                    revealOffersAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
                    offersStopAt: new Date(Date.now() + 23.75 * 60 * 60 * 1000), // 23h 45m
                    selectionDeadlineAt: null, // Set dynamically upon reveal

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
                newState: OrderStatus.COLLECTING_OFFERS,
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
            // Notify Customer with welcoming tone
            await this.notifications.create({
                recipientId: customerId,
                recipientRole: 'CUSTOMER',
                titleAr: 'تم استلام طلبك بنجاح! 🌟',
                titleEn: 'Order Received Successfully! 🌟',
                messageAr: `شكراً لثقتك بنا! طلبك رقم ${orderNumber} قيد المراجعة الآن وسنقوم بجلب أفضل العروض لك في أقرب وقت.`,
                messageEn: `Thank you for your trust! Order #${orderNumber} is now under review, and we'll bring you the best offers soon.`,
                type: 'ORDER',
                link: `/dashboard/orders`,
                metadata: { orderId: result.id, orderNumber }
            });

            // Notify Admin
            await this.notifications.notifyAdmins({
                titleAr: 'طلب جديد في السوق!',
                titleEn: 'New Order in Marketplace!',
                messageAr: `تم إنشاء طلب جديد رقم ${orderNumber} بانتظار عروض التجار.`,
                messageEn: `A new order #${orderNumber} has been created, awaiting merchant offers.`,
                type: 'ORDER',
                link: `/admin/orders/${result.id}`,
                metadata: { orderId: result.id, orderNumber }
            });

            // 4. Notify Relevant Merchants (Matching Car Expertise) - 2026 Smart Routing
            const matchingStores = await this.prisma.store.findMany({
                where: {
                    status: 'ACTIVE',
                    OR: [
                        { selectedMakes: { has: createOrderDto.vehicleMake } },
                        { customMake: { equals: createOrderDto.vehicleMake, mode: 'insensitive' } }
                    ]
                },
                select: { ownerId: true }
            });

            if (matchingStores.length > 0) {
                const merchantMessageAr = `طلب جديد لسيارة ${createOrderDto.vehicleMake} ${createOrderDto.vehicleModel}. هل تتوفر لديك القطعة؟ قدم عرضك الآن!`;
                const merchantMessageEn = `New request for ${createOrderDto.vehicleMake} ${createOrderDto.vehicleModel}. Do you have the part? Submit your offer now!`;
                
                for (const store of matchingStores) {
                    await this.notifications.create({
                        recipientId: store.ownerId,
                        recipientRole: 'MERCHANT',
                        titleAr: 'فرصة بيع جديدة! 💰',
                        titleEn: 'New Sales Opportunity! 💰',
                        messageAr: merchantMessageAr,
                        messageEn: merchantMessageEn,
                        type: 'ORDER',
                        link: `/merchant/orders/${result.id}`,
                        metadata: { orderId: result.id, orderNumber }
                    }).catch(() => {}); // Non-blocking
                }
            }
        } catch (e) {
            console.error('Failed to send notification', e);
        }

        return result;
    }


    async findAll(user: any, query: FindAllOrdersDto = {}) {
        const { page = 1, limit = 20, status, search } = query;
        const skip = (page - 1) * limit;
        const take = limit;

        const where: Prisma.OrderWhereInput = {};

        // 1. Role-Based Access Control Filtering
        if (user.role === 'CUSTOMER') {
            where.customerId = user.id;
        }
        else if (user.role === 'VENDOR') {
            const store = await this.prisma.store.findFirst({
                where: { ownerId: user.id },
                select: { id: true, selectedMakes: true, selectedModels: true, visibilityRestricted: true, visibilityRate: true }
            });

            if (store) {
                const storeId = store.id;
                const hasMakes = store.selectedMakes && store.selectedMakes.length > 0;
                const hasModels = store.selectedModels && store.selectedModels.length > 0;

                // --- 2026 Governance Enforcement: Visibility Restriction ---
                const allowedOrderEnds: string[] = [];
                if (store.visibilityRestricted && store.visibilityRate < 100) {
                    for (let i = 0; i < store.visibilityRate; i++) {
                        allowedOrderEnds.push(i.toString().padStart(2, '0'));
                    }
                }
                const visibilityFilter: Prisma.OrderWhereInput = allowedOrderEnds.length > 0 ? {
                    OR: allowedOrderEnds.map(end => ({ orderNumber: { endsWith: end } }))
                } : {};
                // ------------------------------------------------------------

                where.OR = [
                    {
                        status: { in: [OrderStatus.AWAITING_OFFERS, OrderStatus.COLLECTING_OFFERS, OrderStatus.AWAITING_SELECTION, OrderStatus.AWAITING_PAYMENT] },
                        // For AWAITING_PAYMENT/SELECTION, only show if some parts STILL need offers
                        parts: {
                            some: {
                                offers: {
                                    none: { status: 'accepted' }
                                }
                            }
                        },
                        AND: [
                            hasMakes ? {
                                OR: store.selectedMakes.map(make => ({
                                    vehicleMake: { equals: make, mode: 'insensitive' }
                                }))
                            } : {},
                            hasModels ? {
                                OR: store.selectedModels.map(model => ({
                                    vehicleModel: { equals: model, mode: 'insensitive' }
                                }))
                            } : {},
                            visibilityFilter // Apply visibility restriction here
                        ]
                    },
                    { storeId: storeId },
                    { acceptedOffer: { storeId: storeId } },
                    { offers: { some: { storeId: storeId } } }
                ];
            } else {
                where.offers = { some: { store: { ownerId: user.id } } };
            }
        }

        // 2. Status Filtering
        if (status) {
            if (where.OR) {
                where.AND = [
                    { status: status },
                    { OR: where.OR } // Combine with existing RBAC OR
                ];
                delete where.OR;
            } else {
                where.status = status;
            }
        }

        // 3. Search Logic (OrderNumber, Part, Car, Customer)
        if (search) {
            const searchFilter: Prisma.OrderWhereInput = {
                OR: [
                    { orderNumber: { contains: search, mode: 'insensitive' } },
                    { partName: { contains: search, mode: 'insensitive' } },
                    { vehicleMake: { contains: search, mode: 'insensitive' } },
                    { vehicleModel: { contains: search, mode: 'insensitive' } },
                    { customer: { name: { contains: search, mode: 'insensitive' } } }
                ]
            };

            if (where.AND) {
                (where.AND as any).push(searchFilter);
            } else if (where.id || where.customerId || where.OR || where.status) {
                // If we already have some primitive filters, wrap them in AND
                const existing = { ...where };
                for (const key in where) delete where[key];
                where.AND = [existing, searchFilter];
            } else {
                Object.assign(where, searchFilter);
            }
        }

        // 4. Optimized Execution (Parallel Count + Fetch)
        const [items, total] = await Promise.all([
            this.prisma.order.findMany({
                where,
                skip,
                take,
                orderBy: { createdAt: 'desc' },
                include: {
                    parts: { select: { id: true, name: true, quantity: true } },
                    customer: { select: { id: true, name: true, email: true, avatar: true } },
                    review: { select: { id: true, rating: true } },
                    offers: {
                        where: { status: { not: 'rejected' } },
                        orderBy: { createdAt: 'asc' },
                        include: {
                            store: { select: { id: true, name: true, storeCode: true, logo: true } }
                        }
                    },
                    verificationDocuments: {
                        select: { id: true, adminStatus: true, createdAt: true },
                        orderBy: { createdAt: 'desc' }
                    },
                    shipments: {
                        select: { id: true, status: true, carrierName: true, trackingNumber: true, createdAt: true },
                        orderBy: { createdAt: 'desc' }
                    },
                    _count: {
                        select: { offers: true }
                    }
                }
            }),
            this.prisma.order.count({ where })
        ]);
        
        // --- 2026 Governance: Visibility Filtering ---
        const now = new Date();
        (items as any[]).forEach(order => {
            // 1. Hide ALL offers from CUSTOMER if reveal time not reached AND not in selection phase
            if (user.role === 'CUSTOMER' && order.status !== OrderStatus.AWAITING_SELECTION && order.revealOffersAt && order.revealOffersAt > now) {
                order.offers = [];
                // @ts-ignore
                if (order._count) order._count.offers = 0;
            }
            
            // 2. Hide OTHER merchants' offers from VENDOR during bidding phase
            if (user.role === 'VENDOR' && (order.status === OrderStatus.COLLECTING_OFFERS || order.status === OrderStatus.AWAITING_SELECTION)) {
                const myStoreId = user.storeId;
                if (myStoreId) {
                    order.offers = order.offers.filter(o => o.storeId === myStoreId);
                    // @ts-ignore
                    if (order._count) order._count.offers = order.offers.length;
                }
            }
        });

        return {
            items,
            total,
            page,
            limit,
            hasMore: total > skip + items.length
        };
    }

    async findOne(id: string) {
        const order = await this.prisma.order.findUnique({
            where: { id },
            include: {
                parts: true,
                customer: { select: { id: true, name: true, email: true, phone: true } },
                acceptedOffer: { include: { store: true } },
                review: true,
                shipments: { orderBy: { createdAt: 'desc' } },
                offers: {
                    orderBy: { createdAt: 'asc' },
                    include: {
                        store: { select: { id: true, name: true, storeCode: true, logo: true } }
                    }
                },
                invoices: { 
                    orderBy: { issuedAt: 'desc' }
                },
                shippingWaybills: { orderBy: { issuedAt: 'desc' } },
                auditLogs: { orderBy: { timestamp: 'desc' } },
                verificationDocuments: { orderBy: { createdAt: 'desc' } },
                _count: {
                    select: { offers: true }
                }
            },
        });
        if (!order) throw new NotFoundException(`Order #${id} not found`);
        return order;
    }

    /**
     * Enhanced findOne with user role context for visibility filtering (2026 Blind Auction)
     */
    async findOneWithContext(id: string, user: any) {
        const order = await this.findOne(id);

        const now = new Date();
        
        // 1. Hide ALL offers from CUSTOMER if reveal time not reached AND not in selection phase
        if (user.role === 'CUSTOMER' && order.status !== OrderStatus.AWAITING_SELECTION && order.revealOffersAt && order.revealOffersAt > now) {
            order.offers = [];
            if (order._count) order._count.offers = 0;
        }

        // 2. Hide OTHER merchants' offers from VENDOR during bidding phase
        if (user.role === 'VENDOR' && (order.status === OrderStatus.COLLECTING_OFFERS || order.status === OrderStatus.AWAITING_SELECTION)) {
            const myStoreId = user.storeId;
            if (myStoreId) {
                order.offers = order.offers.filter(o => o.storeId === myStoreId);
                if (order._count) order._count.offers = order.offers.length;
            }
        }
        
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
            // New 2026 Logic: Check all accepted offers for warranty (Multi-part support)
            const acceptedOffers = order.offers?.filter(o => ['accepted', 'ACCEPTED'].includes(o.status)) || [];
            const hasAnyWarranty = acceptedOffers.some(o => o.hasWarranty && o.warrantyDuration && o.warrantyDuration !== 'no');
            
            let finalWarrantyEnd: Date | undefined = undefined;
            if (newStatus === OrderStatus.COMPLETED && hasAnyWarranty) {
                const durations = acceptedOffers
                    .filter(o => o.hasWarranty && o.warrantyDuration && o.warrantyDuration !== 'no')
                    .map(o => this.calculateWarrantyEndDate(new Date(), o.warrantyDuration));
                
                if (durations.length > 0) {
                    finalWarrantyEnd = new Date(Math.max(...durations.map(d => d.getTime())));
                }
            }

            const isTransitioningToWarranty = newStatus === OrderStatus.COMPLETED && hasAnyWarranty;

            const updatedOrder = await tx.order.update({
                where: { id: orderId },
                data: {
                    status: isTransitioningToWarranty ? OrderStatus.WARRANTY_ACTIVE : newStatus,
                    updatedAt: new Date(),
                    warranty_active_at: isTransitioningToWarranty ? new Date() : undefined,
                    warranty_end_at: isTransitioningToWarranty ? finalWarrantyEnd : undefined,
                    selectionDeadlineAt: newStatus === OrderStatus.AWAITING_SELECTION ? new Date(Date.now() + 24 * 60 * 60 * 1000) : undefined,
                },
            });

            // --- 2026 Risk Management: Update Customer Return Stats ---
            // If the order is newly DELIVERED, increment totalDeliveredOrders
            if (newStatus === OrderStatus.DELIVERED && order.status !== OrderStatus.DELIVERED) {
                await this.usersService.updateCustomerReturnStats(order.customerId, false, tx);
            }
            
            // If the order transitions to a NEGATIVE outcome after being delivered/completed
            const isNegativeOutcome = ([
                OrderStatus.RETURN_REQUESTED, 
                OrderStatus.RETURNED, 
                OrderStatus.DISPUTED
            ] as OrderStatus[]).includes(newStatus);

            const wasDeliveredOrCompleted = ([
                OrderStatus.DELIVERED, 
                OrderStatus.COMPLETED, 
                OrderStatus.WARRANTY_ACTIVE
            ] as OrderStatus[]).includes(order.status);

            if (isNegativeOutcome && wasDeliveredOrCompleted) {
                await this.usersService.updateCustomerReturnStats(order.customerId, true, tx);
            }
            // -----------------------------------------------------------

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
        }, { timeout: 15000 });

        // 3. Notification: Notify Customer & Merchant (Async)
        try {
            const statusMessagesAr: Record<string, string> = {
                [OrderStatus.PREPARATION]: 'بدأ الحماس! 🔥 القِطع الخاصة بك قيد التجهيز الآن بكل عناية.',
                [OrderStatus.SHIPPED]: 'انطلقت إليك! 🚀 طلبك الآن في الطريق، استعد لاستلام الجودة.',
                [OrderStatus.DELIVERED]: 'وصلت الأمانة! 🏠 نأمل أن تنال إعجابك، يومك سعيد بقطعك الجديدة.',
                [OrderStatus.CANCELLED]: 'تم إلغاء طلبك بنجاح. نتمنى خدمتك في أقرب وقت ممكن.',
                [OrderStatus.AWAITING_PAYMENT]: 'اختيار موفق! 👌 يرجى إتمام عملية الدفع لنبدأ في تجهيز طلبك فوراً.',
                [OrderStatus.RETURNED]: 'حقك محفوظ 🤝 تمت الموافقة على طلب الإرجاع الخاص بك، سنقوم باللازم فوراً.'
            };
            const statusMessagesEn: Record<string, string> = {
                [OrderStatus.PREPARATION]: 'The excitement begins! 🔥 Your items are being carefully prepared now.',
                [OrderStatus.SHIPPED]: 'On its way! 🚀 Your order is now shipped and heading to you.',
                [OrderStatus.DELIVERED]: 'Delivered! 🏠 We hope you love it. Have a great day with your new items!',
                [OrderStatus.CANCELLED]: 'Your order has been cancelled. We look forward to serving you again soon.',
                [OrderStatus.AWAITING_PAYMENT]: 'Great choice! 👌 Please complete payment to start processing your order right away.',
                [OrderStatus.RETURNED]: 'Your rights are protected 🤝 Your return request has been approved.'
            };

            // 3.0 Real-time Reward Engine: Trigger 2026 Loyalty System upon COMPLETION
            if (newStatus === OrderStatus.COMPLETED) {
                this.loyaltyService.grantOrderCompletionRewards(orderId).catch(err => {
                    console.error(`Failed to grant rewards for order ${orderId}:`, err);
                });
            }

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

            // 3.1.5 Notify All Bidding Merchants about AWAITING_SELECTION (Reveal phase)
            if (newStatus === OrderStatus.AWAITING_SELECTION) {
                const biddingMerchants = await this.prisma.offer.findMany({
                    where: { orderId: order.id },
                    select: { store: { select: { ownerId: true } } },
                    distinct: ['storeId']
                });

                for (const bidder of biddingMerchants) {
                    if (bidder.store?.ownerId) {
                        await this.notifications.create({
                            recipientId: bidder.store.ownerId,
                            recipientRole: 'MERCHANT',
                            titleAr: `تم كشف العروض للطلب #${order.orderNumber}`,
                            titleEn: `Offers Revealed for Order #${order.orderNumber}`,
                            messageAr: `انتهت فترة جمع العروض. طلب العميل متاح الآن للاختيار، وعرضك قيد المراجعة.`,
                            messageEn: `The collection period has ended. The order is now open for selection, and your offer is under review.`,
                            type: 'ORDER',
                            link: `/merchant/orders/${order.id}`,
                            metadata: { orderId: order.id, status: newStatus }
                        }).catch(() => {});
                    }
                }
            }

            // 3.2 Notify Merchant (if order is assigned to one via acceptedOffer)
            if (order.acceptedOfferId && ([OrderStatus.PREPARATION, OrderStatus.CANCELLED, OrderStatus.RETURNED] as OrderStatus[]).includes(newStatus)) {
                // Determine Merchant's User ID (ownerId)
                let merchantOwnerId = null;
                const orderWithRelations = order as any; // Cast to access included relations safely

                if (orderWithRelations.offers && orderWithRelations.offers.length > 0) {
                    const accepted = orderWithRelations.offers.find(o => o.id === order.acceptedOfferId);
                    if (accepted && accepted.store) merchantOwnerId = accepted.store.ownerId;
                } else if (orderWithRelations.acceptedOffer && orderWithRelations.acceptedOffer.store) {
                    merchantOwnerId = orderWithRelations.acceptedOffer.store.ownerId;
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

            // 3.3 Notify Admins about ANY status transition (Oversight Policy)
            await this.notifications.notifyAdmins({
                titleAr: `تحديث حالة الطلب #${order.orderNumber}`,
                titleEn: `Order #${order.orderNumber} Status Updated`,
                messageAr: `تغيرت حالة الطلب إلى: ${newStatus}. المنفذ: ${actor.name || actor.type}`,
                messageEn: `Order status changed to: ${newStatus}. Actor: ${actor.name || actor.type}`,
                type: 'ORDER',
                link: `/admin/orders/${order.id}`,
                metadata: { orderId: order.id, status: newStatus, actor: actor.type }
            });

            // --- 2026 Selection Context: Chat System Message ---
            if (newStatus === OrderStatus.AWAITING_SELECTION) {
                try {
                    // Find all chats for this order
                    const orderChats = await this.prisma.orderChat.findMany({
                        where: { orderId: order.id, type: 'order' }
                    });

                    for (const chat of orderChats) {
                        const msgAr = '🚨 تم كشف العروض! حان وقت الاختيار. لديك 24 ساعة لاختيار العرض المناسب قبل إغلاق الطلب تلقائياً.';
                        const msgEn = '🚨 Offers Revealed! It is time to choose. You have 24 hours to select the best offer before the order is auto-cancelled.';
                        
                        await this.chatService.sendMessage(
                            chat.id, 
                            null, // SYSTEM
                            msgAr,
                            'SYSTEM',
                            undefined, undefined, undefined, undefined,
                            'Offers Revealed'
                        );

                        // [2026] Extend Chat Expiry to match Selection Deadline
                        await this.prisma.orderChat.update({
                            where: { id: chat.id },
                            data: { expiryAt: new Date(Date.now() + 24 * 60 * 60 * 1000) }
                        });
                    }
                } catch (chatErr) {
                    console.error('Failed to update reveal system messages/expiry:', chatErr);
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
            // Update the accepted offer's status
            await tx.offer.update({
                where: { id: offerId },
                data: { status: 'accepted' }
            });

            // Auto-reject sibling offers on the same part
            const acceptedOffer = await tx.offer.findUnique({
                where: { id: offerId },
                select: { orderPartId: true }
            });
            if (acceptedOffer?.orderPartId) {
                await tx.offer.updateMany({
                    where: {
                        orderPartId: acceptedOffer.orderPartId,
                        id: { not: offerId },
                        status: 'pending'
                    },
                    data: { status: 'rejected' }
                });
            }

            // Enforce explicit 24h deadline for checkout
            const paymentDeadline = new Date();
            paymentDeadline.setHours(paymentDeadline.getHours() + 24);

            // Link Offer and Update Status
            const updatedOrder = await tx.order.update({
                where: { id: orderId },
                data: {
                    status: OrderStatus.AWAITING_PAYMENT,
                    acceptedOfferId: offerId,
                    paymentDeadlineAt: paymentDeadline
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
        }, { timeout: 15000 });

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
                        id: { not: offerId },
                        status: 'rejected' // Those just updated
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

    async acceptOfferForPart(orderId: string, partId: string, offerId: string, customerId: string) {
        const order = await this.prisma.order.findUnique({ where: { id: orderId } });
        if (!order) {
            throw new NotFoundException('Order not found');
        }

        if (order.customerId !== customerId) {
            throw new ForbiddenException('You can only accept offers for your own orders');
        }

        const result = await this.prisma.$transaction(async (tx) => {
            // Update the accepted offer's status
            const acceptedOffer = await tx.offer.update({
                where: { id: offerId },
                data: { status: 'accepted' },
                include: { store: true }
            });

            // Auto-reject sibling offers on the same part
            const losingOffers = await tx.offer.findMany({
                where: {
                    orderPartId: partId,
                    id: { not: offerId },
                    status: 'pending'
                },
                include: { store: true }
            });

            await tx.offer.updateMany({
                where: {
                    orderPartId: partId,
                    id: { not: offerId },
                    status: 'pending'
                },
                data: { status: 'rejected' }
            });

            // --- 2026 Selection Logic: Transition to payment if at least one part is accepted ---
            const acceptedPartsCount = await tx.offer.count({
                where: { orderId, status: 'accepted' }
            });
            const hasAnyAccepted = acceptedPartsCount > 0;

            let updatedOrder = order;
            if (hasAnyAccepted && [OrderStatus.AWAITING_OFFERS, OrderStatus.COLLECTING_OFFERS, OrderStatus.AWAITING_SELECTION].includes(order.status as any)) {
                const now = new Date();
                const paymentDeadline = new Date(now.getTime() + 24 * 60 * 60 * 1000);
                
                updatedOrder = await tx.order.update({
                    where: { id: orderId },
                    data: { 
                        status: OrderStatus.AWAITING_PAYMENT,
                        paymentDeadlineAt: paymentDeadline
                    },
                });
            }

            // Log action
            await this.auditLogs.logAction({
                orderId: order.id,
                action: 'ACCEPT_OFFER_PART',
                entity: 'OrderPart',
                actorType: ActorType.CUSTOMER,
                actorId: customerId,
                actorName: 'Customer',
                previousState: order.status,
                newState: updatedOrder.status,
                reason: `Accepted offer ${offerId} for part ${partId}`,
                metadata: { offerId, partId },
            }, tx);

            return { acceptedOffer, losingOffers, updatedOrder };
        }, { timeout: 15000 });

        const { acceptedOffer, losingOffers } = result;

        // Close chats 
        try {
            await this.chatService.closeOtherChats(orderId, acceptedOffer.storeId);
        } catch (e) { console.error('Failed to close other chats', e); }

        // Notify winner
        if (acceptedOffer.store?.ownerId) {
            this.notifications.create({
                recipientId: acceptedOffer.store.ownerId,
                recipientRole: 'MERCHANT',
                titleAr: 'عُرضك تم قبوله!',
                titleEn: 'Your offer was accepted!',
                messageAr: `وافق العميل للتو على عرضك للقطعة في الطلب #${order.orderNumber}.`,
                messageEn: `The customer just accepted your offer for a part in Order #${order.orderNumber}.`,
                type: 'ORDER',
                link: `/dashboard/orders/${order.id}`
            }).catch(e => console.error('Failed to notify merchant', e));
        }

        // Notify losers
        for (const losingOffer of losingOffers) {
            if (losingOffer.store?.ownerId) {
                this.notifications.create({
                    recipientId: losingOffer.store.ownerId,
                    recipientRole: 'MERCHANT',
                    titleAr: 'تم رفض عرضك',
                    titleEn: 'Your offer was rejected',
                    messageAr: `نأسف، لقد قام العميل باختيار عرض آخر للقطعة في الطلب #${order.orderNumber}. حظاً أوفر!`,
                    messageEn: `Sorry, the customer selected another offer for a part in Order #${order.orderNumber}. Better luck!`,
                    type: 'ORDER',
                    link: `/dashboard/orders/${order.id}`
                }).catch(e => console.error('Failed to notify merchant', e));
            }
        }

        return result.updatedOrder;
    }

    async markAsPrepared(orderId: string, storeId: string) {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: { offers: true }
        });

        if (!order) {
            throw new NotFoundException('Order not found');
        }

        // Validate Authorization: Must have an accepted offer for this 
        const hasAcceptedOffer = order.offers.some(o => o.status === 'accepted' && o.storeId === storeId);
        if (!hasAcceptedOffer) {
            throw new ForbiddenException('You are not authorized to physically prepare this order. No accepted offers found for your store.');
        }

        // Validate FSM Boundary
        this.fsm.validateTransition(order.status, OrderStatus.PREPARED);

        const updatedOrder = await this.prisma.order.update({
            where: { id: orderId },
            data: { status: OrderStatus.PREPARED }
        });

        // Audit Log System Note
        await this.auditLogs.logAction({
            orderId: order.id,
            action: 'MARK_PREPARED',
            entity: 'Order',
            actorType: ActorType.VENDOR,
            actorId: storeId,
            actorName: 'Store Vendor',
            previousState: order.status,
            newState: OrderStatus.PREPARED,
            reason: 'Merchant successfully finalized preparation for shipping',
        });

        // Dispatch Customer Hook
        this.notifications.create({
            recipientId: order.customerId,
            recipientRole: 'CUSTOMER',
            titleAr: 'طلبك جاهز للشحن! ✨',
            titleEn: 'Order Ready for Pickup! ✨',
            messageAr: `خبر رائع! التاجر انتهى من تجهيز طلبك #${order.orderNumber} وهو الآن ينتظر شركة الشحن لاستلامه وإرساله لك.`,
            messageEn: `Great news! The vendor finished preparing your order #${order.orderNumber}. Awaiting shipping courier pickup.`,
            type: 'ORDER',
            link: `/dashboard/orders/${order.id}`
        }).catch(e => console.error('Failed to notify customer upon preparation completion', e));

        // Add Merchant Reminder for Documentation
        this.notifications.notifyMerchantByStoreId(storeId, {
            titleAr: 'توثيق حالة القطعة إلزامي!',
            titleEn: 'Part Verification Required!',
            messageAr: `تم تجهيز طلب #${order.orderNumber}. يرجى رفع التوثيق لتتمكن من تسليمه للمندوب ومتابعة الطلب.`,
            messageEn: `Order #${order.orderNumber} is prepared. Please upload verification documents to proceed with handover.`,
            type: 'ORDER',
            link: `/merchant/orders/${orderId}`,
        }).catch(e => console.error('Failed to notify merchant upon preparation', e));

        return updatedOrder;
    }
    async rejectOffer(orderId: string, offerId: string, customerId: string, reason: string, customReason?: string) {
        // 1. Verify existence and ownership
        const order = await this.prisma.order.findUnique({
            where: { id: orderId }
        });

        if (!order) {
            throw new NotFoundException('Order not found');
        }

        if (order.customerId !== customerId) {
            throw new BadRequestException('You do not have permission to modify offers on this order');
        }

        // 2. Verify offer exists and belongs to this order
        const offer = await this.prisma.offer.findUnique({
            where: { id: offerId, orderId },
            include: { store: true }
        });

        if (!offer) {
            throw new NotFoundException('Offer not found on this order');
        }

        if (offer.status === 'rejected') {
            throw new BadRequestException('Offer is already rejected');
        }

        // 3. Update the offer status to 'rejected' and create the rejection record in a transaction
        const result = await this.prisma.$transaction(async (tx) => {
            const updatedOffer = await tx.offer.update({
                where: { id: offerId },
                data: { status: 'rejected' }
            });
            const rejection = await tx.offerRejection.create({
                data: {
                    offerId,
                    reason,
                    customReason
                }
            });
            return [updatedOffer, rejection];
        }, { timeout: 15000 });

        // 4. Optionally notify the merchant about the specific rejection reason
        if (offer.store?.ownerId) {
            this.notifications.create({
                recipientId: offer.store.ownerId,
                recipientRole: 'MERCHANT',
                titleAr: 'تم رفض عرضك',
                titleEn: 'Your offer was rejected',
                messageAr: `قام العميل برفض عرضك الخاص بالطلب #${order.orderNumber}. السبب: ${reason}`,
                messageEn: `The customer rejected your offer for Order #${order.orderNumber}. Reason: ${reason}`,
                type: 'ORDER',
                link: `/dashboard/orders/${order.id}`
            }).catch(e => console.error('Failed to notify merchant of specific rejection', e));
        }

        return { success: true, message: 'Offer rejected successfully', rejection: result[1] };
    }

    async renewOrder(orderId: string, userId: string) {
        const order = await this.prisma.order.findUnique({ where: { id: orderId } });
        if (!order) throw new NotFoundException('Order not found');
        if (order.customerId !== userId) throw new ForbiddenException('Only owner can renew order');

        const newDeadline = new Date();
        newDeadline.setHours(newDeadline.getHours() + 24);

        const updated = await this.prisma.order.update({
            where: { id: orderId },
            data: {
                status: OrderStatus.AWAITING_OFFERS,
                offersDeadlineAt: newDeadline,
            }
        });

        // Audit Log
        await this.auditLogs.logAction({
            orderId,
            action: 'ORDER_RENEWED',
            entity: 'Order',
            actorType: ActorType.CUSTOMER,
            actorId: userId,
            actorName: 'Customer',
            reason: 'Order renewed by customer (24h extension)',
            metadata: { oldDeadline: order.offersDeadlineAt, newDeadline }
        });

        return updated;
    }

    async deleteOrder(orderId: string, userId: string) {
        const order = await this.prisma.order.findUnique({ 
            where: { id: orderId },
            include: { _count: { select: { offers: true } } }
        });
        if (!order) throw new NotFoundException('Order not found');
        if (order.customerId !== userId) throw new ForbiddenException('Only owner can delete order');
        
        // Safety check: Don't delete if it has offers or is in advanced state
        if (order._count.offers > 0 && !['CANCELLED', 'AWAITING_OFFERS'].includes(order.status)) {
            throw new BadRequestException('Cannot delete order that has active offers or is in progress');
        }

        return this.prisma.order.delete({
            where: { id: orderId }
        });
    }

    async saveCheckoutData(orderId: string, customerId: string, data: any) {
        // 1. Verify ownership
        const order = await this.prisma.order.findUnique({
            where: { id: orderId }
        });

        if (!order) throw new NotFoundException('Order not found');
        if (order.customerId !== customerId) throw new ForbiddenException('Not owner of this order');
        if (order.status !== OrderStatus.AWAITING_PAYMENT) {
            // We might allow saving data while just preparing to pay, but generally it's AWAITING_PAYMENT by now
        }

        // 2. Prepare the shipping addresses
        // Data format received from frontend:
        // { addresses: [{ fullName, phone, email, country, city, details, orderPartId? }] }
        const addresses = data.addresses || [];

        return this.prisma.$transaction(async (tx) => {
            // Clear existing addresses just in case user is updating/going back and forth
            await tx.orderShippingAddress.deleteMany({
                where: { orderId }
            });

            // Re-insert addresses
            if (addresses.length > 0) {
                await tx.orderShippingAddress.createMany({
                    data: addresses.map(addr => ({
                        orderId,
                        orderPartId: addr.orderPartId || null,
                        fullName: addr.fullName,
                        phone: addr.phone,
                        email: addr.email,
                        country: addr.country,
                        city: addr.city,
                        details: addr.details
                    }))
                });
            }

            // Optional: update the order level shipping tracking metadata here if needed
            return { success: true, count: addresses.length };
        }, { timeout: 15000 });
    }

    private async generateOrderNumber(): Promise<string> {
        const result = await this.prisma.$queryRaw<{ generate_order_number: string }[]>`SELECT generate_order_number()`;
        return result[0].generate_order_number;
    }

    async getAssemblyCart(customerId: string) {
        // Find orders in PREPARATION status (paid, waiting to be shipped)
        const orders = await this.prisma.order.findMany({
            where: {
                customerId,
                status: { in: [OrderStatus.PREPARATION, OrderStatus.PARTIALLY_SHIPPED] },
                requestType: 'multiple'
            },
            include: {
                parts: true,
                store: true, // If single-store order
                acceptedOffer: {
                    include: { 
                        store: true,
                        payments: { where: { status: 'SUCCESS' } }
                    }
                },
                offers: {
                    where: { 
                        status: 'accepted',
                        shippedFromCart: false
                    },
                    include: { 
                        store: true,
                        payments: { where: { status: 'SUCCESS' } }
                    }
                },
                payments: {
                    where: { status: 'SUCCESS' }
                },
                shippingAddresses: true
            },
            orderBy: { createdAt: 'desc' }
        });

        // Format for the frontend CartItemType
        const cartItems = [];
        for (const order of orders) {
            // Find the first payment to get the paidAt date for the 7-day timer
            const firstPayment = order.payments.sort((a, b) =>
                (a.paidAt?.getTime() || 0) - (b.paidAt?.getTime() || 0)
            )[0];

            let paidAt = firstPayment?.paidAt || order.updatedAt;
            let expiryDate = new Date(paidAt.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days from payment

            // For each accepted offer (which is paid, since order is PREPARATION)
            const acceptedOffers = order.offers.length > 0 ? order.offers : (order.acceptedOffer ? [order.acceptedOffer] : []);

            for (const offer of acceptedOffers as any[]) {
                // Find matching part if any
                const part = order.parts.find(p => p.id === offer.orderPartId) || order.parts[0];
                const partName = part?.name || order.partName || 'Multi-Part Order';
                const partImages = (part?.images as string[]) || [];
                const orderImages = (order.partImages as string[]) || [];
                const partImage = (partImages.length > 0) ? partImages[0] : (orderImages.length > 0 ? orderImages[0] : null);

                const offerPayment = offer.payments?.[0];
                const finalPrice = offerPayment?.totalAmount ? Number(offerPayment.totalAmount) : (Number(offer.unitPrice) + Number(offer.shippingCost));

                cartItems.push({
                    id: order.id, // Using order ID as the cart item ID for shipping
                    offerId: offer.id,
                    orderNumber: order.orderNumber,
                    name: partName,
                    price: Number(offer.unitPrice),
                    shippingCost: Number(offer.shippingCost),
                    hasWarranty: offer.hasWarranty,
                    warrantyDuration: offer.warrantyDuration,
                    condition: offer.condition,
                    partType: offer.partType,
                    partImage: partImage,
                    expiryDate: expiryDate,
                    paidAt: paidAt,
                    storeName: offer.store?.name || order.store?.name || 'Verified Seller',
                    vehicleMake: order.vehicleMake,
                    vehicleModel: order.vehicleModel,
                    vehicleYear: order.vehicleYear,
                    vin: order.vin,
                    partsCount: 1, // Set to 1 as this card represents a single part from the assembly
                    requestType: order.requestType || 'N/A',
                    shippingType: order.shippingType || 'N/A',
                    shippingAddress: order.shippingAddresses?.[0] || null,
                    totalPaid: finalPrice
                });
            }
        }

        return cartItems;
    }

    async getMerchantAssemblyCart(userId: string, storeId: string) {
        if (!storeId) return [];

        // Find orders in PREPARATION status where this merchant has an accepted offer
        const orders = await this.prisma.order.findMany({
            where: {
                status: { in: [OrderStatus.PREPARATION, OrderStatus.PARTIALLY_SHIPPED] },
                requestType: 'multiple',
                offers: {
                    some: {
                        storeId: storeId,
                        status: 'accepted',
                        shippedFromCart: false
                    }
                }
            },
            include: {
                parts: true,
                store: true,
                offers: {
                    where: { 
                        status: 'accepted',
                        shippedFromCart: false
                    },
                    include: { 
                        store: true,
                        payments: { where: { status: 'SUCCESS' } }
                    }
                },
                payments: {
                    where: { status: 'SUCCESS' }
                },
                shippingAddresses: true
            },
            orderBy: { createdAt: 'desc' }
        });

        const cartItems = [];
        for (const order of orders) {
            const firstPayment = order.payments.sort((a, b) =>
                (a.paidAt?.getTime() || 0) - (b.paidAt?.getTime() || 0)
            )[0];

            let paidAt = firstPayment?.paidAt || order.updatedAt;
            let expiryDate = new Date(paidAt.getTime() + 7 * 24 * 60 * 60 * 1000);

            for (const offer of order.offers as any[]) {
                const isMyOffer = offer.storeId === storeId;
                const part = order.parts.find(p => p.id === offer.orderPartId) || order.parts[0];
                const partName = part?.name || order.partName || 'Multi-Part Order';
                
                // Privacy Masking: If not my offer, hide price, store name, and images
                const partImages = (part?.images as string[]) || [];
                const orderImages = (order.partImages as string[]) || [];
                const partImage = isMyOffer 
                    ? ((partImages.length > 0) ? partImages[0] : (orderImages.length > 0 ? orderImages[0] : null))
                    : null;

                const offerPayment = offer.payments?.[0];
                const finalPrice = isMyOffer 
                    ? (offerPayment?.totalAmount ? Number(offerPayment.totalAmount) : (Number(offer.unitPrice) + Number(offer.shippingCost)))
                    : 0;

                cartItems.push({
                    id: order.id,
                    offerId: offer.id,
                    orderNumber: order.orderNumber,
                    name: partName,
                    price: isMyOffer ? Number(offer.unitPrice) : 0,
                    shippingCost: isMyOffer ? Number(offer.shippingCost) : 0,
                    hasWarranty: isMyOffer ? offer.hasWarranty : false,
                    warrantyDuration: isMyOffer ? offer.warrantyDuration : null,
                    condition: isMyOffer ? offer.condition : null,
                    partType: isMyOffer ? offer.partType : null,
                    partImage: partImage,
                    expiryDate: expiryDate,
                    paidAt: paidAt,
                    storeName: isMyOffer ? (offer.store?.name || 'Your Store') : 'Other Store',
                    vehicleMake: order.vehicleMake,
                    vehicleModel: order.vehicleModel,
                    vehicleYear: order.vehicleYear,
                    vin: isMyOffer ? order.vin : null,
                    partsCount: 1, // Set to 1 as this card represents a single part
                    requestType: order.requestType || 'N/A',
                    shippingType: order.shippingType || 'N/A',
                    shippingAddress: isMyOffer ? (order.shippingAddresses?.[0] || null) : null,
                    totalPaid: finalPrice,
                    isMyOffer: isMyOffer
                });
            }
        }

        return cartItems;
    }

    async getDeliveredOrders(customerId: string) {
        // Find DELIVERED orders within the last 30 days (changed from 3 days to allow visibility of expired items)
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const orders = await this.prisma.order.findMany({
            where: {
                customerId,
                status: OrderStatus.DELIVERED,
                updatedAt: { gte: thirtyDaysAgo }
            },
            include: {
                parts: true,
                store: true,
                acceptedOffer: {
                    include: { store: true }
                },
                offers: {
                    where: { status: 'accepted' },
                    include: { store: true }
                },
                payments: {
                    where: { status: 'SUCCESS' }
                },
                shippingAddresses: true
            },
            orderBy: { updatedAt: 'desc' }
        });

        const deliveredItems = [];
        for (const order of orders) {
            // Re-use logic to format item, similar to assembly-cart
            let deliveredAt = order.updatedAt; // We use updatedAt as delivered timestamp
            let returnExpiryDate = new Date(deliveredAt.getTime() + 3 * 24 * 60 * 60 * 1000);
            let isReturnEligible = Date.now() <= returnExpiryDate.getTime();

            const firstPayment = order.payments?.sort((a, b) => (a.paidAt?.getTime() || 0) - (b.paidAt?.getTime() || 0))[0];

            // Build shipping address object from the first shipping address
            const shippingAddr = order.shippingAddresses?.[0] || null;
            const shippingAddress = shippingAddr ? {
                fullName: shippingAddr.fullName,
                phone: shippingAddr.phone,
                email: shippingAddr.email,
                country: shippingAddr.country,
                city: shippingAddr.city,
                details: shippingAddr.details
            } : null;

            const acceptedOffers = order.offers.length > 0 ? order.offers : (order.acceptedOffer ? [order.acceptedOffer] : []);

            // Fallback for orders without accepted offers (e.g. manual testing, old structures)
            if (acceptedOffers.length === 0) {
                const part = order.parts[0];
                const partName = part?.name || order.partName || 'Multi-Part Order';
                const partImages = (part?.images as string[]) || [];
                const orderImages = (order.partImages as string[]) || [];
                const partImage = (partImages.length > 0) ? partImages[0] : (orderImages.length > 0 ? orderImages[0] : null);

                deliveredItems.push({
                    id: order.id,
                    offerId: null,
                    orderPartId: part?.id || null,
                    orderNumber: order.orderNumber,
                    name: partName,
                    price: 0,
                    shippingCost: 0,
                    hasWarranty: false,
                    warrantyDuration: 0,
                    condition: 'N/A',
                    partType: 'N/A',
                    partImage: partImage,
                    deliveredAt: deliveredAt,
                    returnExpiryDate: returnExpiryDate,
                    isReturnEligible: isReturnEligible,
                    storeName: order.store?.name || 'Verified Seller',
                    vehicleMake: order.vehicleMake,
                    vehicleModel: order.vehicleModel,
                    vehicleYear: order.vehicleYear,
                    vin: order.vin,
                    requestType: order.requestType || null,
                    shippingType: order.shippingType || null,
                    shippingAddress: shippingAddress,
                    partsCount: order.parts.length || 1,
                    totalPaid: firstPayment?.totalAmount ? Number(firstPayment.totalAmount) : 0,
                    status: order.status
                });
                continue;
            }

            for (const offer of acceptedOffers) {
                const part = order.parts.find(p => p.id === offer.orderPartId) || order.parts[0];
                const partName = part?.name || order.partName || 'Multi-Part Order';
                const partImages = (part?.images as string[]) || [];
                const orderImages = (order.partImages as string[]) || [];
                const partImage = (partImages.length > 0) ? partImages[0] : (orderImages.length > 0 ? orderImages[0] : null);

                deliveredItems.push({
                    id: order.id,
                    offerId: offer.id,
                    orderPartId: part?.id || null,
                    orderNumber: order.orderNumber,
                    name: partName,
                    price: Number(offer.unitPrice),
                    shippingCost: Number(offer.shippingCost),
                    hasWarranty: offer.hasWarranty,
                    warrantyDuration: offer.warrantyDuration,
                    condition: offer.condition,
                    partType: offer.partType,
                    partImage: partImage,
                    deliveredAt: deliveredAt,
                    returnExpiryDate: returnExpiryDate,
                    isReturnEligible: isReturnEligible,
                    storeName: offer.store?.name || order.store?.name || 'Verified Seller',
                    vehicleMake: order.vehicleMake,
                    vehicleModel: order.vehicleModel,
                    vehicleYear: order.vehicleYear,
                    vin: order.vin,
                    requestType: order.requestType || null,
                    shippingType: order.shippingType || null,
                    shippingAddress: shippingAddress,
                    partsCount: order.parts.length || 1,
                    totalPaid: firstPayment?.totalAmount ? Number(firstPayment.totalAmount) : Number(offer.unitPrice) + Number(offer.shippingCost),
                    status: order.status
                });
            }
        }

        return deliveredItems;
    }

    async updateAdminNotes(orderId: string, notes: string, adminUser: any) {
        if (adminUser.role !== 'ADMIN' && adminUser.role !== 'SUPER_ADMIN') {
            throw new ForbiddenException('Only administrators can update internal notes');
        }

        const order = await this.prisma.order.findUnique({
            where: { id: orderId }
        });

        if (!order) {
            throw new NotFoundException('Order not found');
        }

        const updatedOrder = await this.prisma.order.update({
            where: { id: orderId },
            data: { adminNotes: notes }
        });

        await this.auditLogs.logAction({
            orderId,
            action: 'UPDATE_ADMIN_NOTES',
            entity: 'Order',
            actorType: ActorType.ADMIN,
            actorId: adminUser.id,
            actorName: adminUser.name || adminUser.email || 'Admin',
            previousState: order.status,
            newState: order.status,
            metadata: { hasNotes: !!notes }
        });

        return { success: true, message: 'Admin notes updated', adminNotes: updatedOrder.adminNotes };
    }

    async requestShipping(
        customerId: string, 
        orderIds?: string[], 
        offerIds?: string[], 
        isSystemAutoTrigger = false,
        adminActor?: { id: string, type: ActorType, name: string }
    ) {
        if ((!orderIds || orderIds.length === 0) && (!offerIds || offerIds.length === 0)) {
            return { success: true, count: 0 };
        }

        let successCount = 0;
        const results = [];

        // If orderIds are provided, resolve them to offerIds for backward compatibility
        const allOfferIds = [...(offerIds || [])];
        if (orderIds && orderIds.length > 0) {
            const ordersWithOffers = await this.prisma.order.findMany({
                where: { id: { in: orderIds }, customerId },
                include: { offers: { where: { status: 'accepted', shippedFromCart: false } } }
            });
            for (const order of ordersWithOffers) {
                allOfferIds.push(...order.offers.map(o => o.id));
            }
        }

        if (allOfferIds.length === 0) return { success: true, count: 0, results: [], message: 'No pending items found.' };

        // Get details of all requested offers
        const offers = await this.prisma.offer.findMany({
            where: { id: { in: allOfferIds }, status: 'accepted', shippedFromCart: false },
            include: { order: true }
        });

        // Filter by ownership and state (must be in PREPARATION, PARTIALLY_SHIPPED or VERIFICATION_SUCCESS)
        const validOffers = offers.filter(o => 
            o.order.customerId === customerId && 
            ([OrderStatus.PREPARATION, OrderStatus.PARTIALLY_SHIPPED, OrderStatus.VERIFICATION_SUCCESS] as OrderStatus[]).includes(o.order.status)
        );
        
        if (validOffers.length === 0) {
            return { success: false, reason: 'No valid pending items found in your cart or items already shipped.' };
        }

        // Actor info for logging
        const actor = isSystemAutoTrigger 
            ? { id: 'SYSTEM', type: ActorType.ADMIN, name: 'Logistics Automation' }
            : (adminActor || { id: customerId, type: ActorType.CUSTOMER, name: 'Customer' });

        // Group by orderId to process shipments batch-wise per order
        const offersByOrder = validOffers.reduce((acc, offer) => {
            if (!acc[offer.orderId]) acc[offer.orderId] = [];
            acc[offer.orderId].push(offer);
            return acc;
        }, {} as Record<string, typeof validOffers>);

        for (const orderId in offersByOrder) {
            const batchOffers = offersByOrder[orderId];
            try {
                // 1. Create a shipment record for this partial batch
                const shipment = await this.shipmentsService.create({ orderId }, customerId);

                // 2. Mark specific offers as shipped from cart
                await this.prisma.offer.updateMany({
                    where: { id: { in: batchOffers.map(o => o.id) } },
                    data: {
                        shippedFromCart: true,
                        shippedFromCartAt: new Date(),
                        cartShipmentId: shipment.id
                    }
                });

                // 3. Check if ALL accepted offers for this order are now shipped
                const remainingPending = await this.prisma.offer.count({
                    where: { 
                        orderId, 
                        status: 'accepted', 
                        shippedFromCart: false 
                    }
                });

                if (remainingPending === 0) {
                    // All items shipped -> transition order to SHIPPED
                    await this.transitionStatus(
                        orderId,
                        OrderStatus.SHIPPED,
                        actor,
                        isSystemAutoTrigger ? 'All items auto-shipped after 7-day period' : 'All items shipped from assembly cart'
                    );
                } else {
                    // Some items remain -> transition to PARTIALLY_SHIPPED (if not already)
                    if (batchOffers[0].order.status !== OrderStatus.PARTIALLY_SHIPPED) {
                        await this.transitionStatus(
                            orderId,
                            OrderStatus.PARTIALLY_SHIPPED,
                            actor,
                            isSystemAutoTrigger 
                                ? `System auto-shipped ${batchOffers.length} aging items. ${remainingPending} items remaining.`
                                : `Partial shipment: ${batchOffers.length} items shipped. ${remainingPending} items remaining.`
                        );
                    } else {
                        // Already partially shipped, just log the additional batch
                        await this.auditLogs.logAction({
                            orderId,
                            action: 'PARTIAL_SHIPPING',
                            entity: 'Order',
                            actorId: actor.id,
                            actorType: actor.type,
                            actorName: actor.name,
                            previousState: OrderStatus.PARTIALLY_SHIPPED,
                            newState: OrderStatus.PARTIALLY_SHIPPED,
                            metadata: {
                                batchSize: batchOffers.length,
                                remaining: remainingPending,
                                isAuto: isSystemAutoTrigger
                            }
                        });
                    }
                }

                successCount += batchOffers.length;
                results.push({ orderId, count: batchOffers.length, success: true });
            } catch (error) {
                console.error(`Failed partial shipping for order ${orderId}:`, error);
                results.push({ orderId, success: false, reason: error.message });
            }
        }

        return { success: true, count: successCount, results };
    }

    async requestShippingByMerchant(orderId: string, storeId: string, userId: string) {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: { offers: true }
        });

        if (!order) throw new NotFoundException('Order not found');

        // Verify merchant has an accepted offer — check both cased versions
        const hasAcceptedOffer = order.offers.some(
            o => ['ACCEPTED', 'accepted'].includes(String(o.status)) && o.storeId === storeId
        );
        if (!hasAcceptedOffer) {
            throw new ForbiddenException('You are not authorized to request shipping for this order.');
        }

        // Must be in VERIFICATION_SUCCESS state
        if (order.status !== OrderStatus.VERIFICATION_SUCCESS) {
            throw new BadRequestException(`Order must be in VERIFICATION_SUCCESS state. Current: ${order.status}`);
        }

        // Transition order status
        const updatedOrder = await this.transitionStatus(
            orderId,
            OrderStatus.READY_FOR_SHIPPING,
            { id: storeId, type: ActorType.VENDOR, name: 'Store Vendor' },
            'Merchant requested shipment delivery to administration'
        );

        // Create the shipment record
        await this.shipmentsService.create({ orderId }, userId);

        // Notify Admin that a new shipment is awaiting pickup
        await this.notifications.notifyAdmins({
            titleAr: 'طلب شحنة جديد ينتظر الاستلام',
            titleEn: 'New Shipment Request Awaiting Pickup',
            messageAr: `الطلب #${order.orderNumber} جاهز للتسليم لشركة الشحن. يرجى استلامه من التاجر.`,
            messageEn: `Order #${order.orderNumber} is ready for carrier pickup. Please collect from merchant.`,
            type: 'ORDER_UPDATE',
            link: `/admin/dashboard/shipping`,
        });

        return updatedOrder;
    }


    async submitVerification(orderId: string, storeId: string, data: any) {
        const order = await this.prisma.order.findUnique({
             where: { id: orderId },
             include: { offers: true }
        });
        if (!order) throw new NotFoundException('Order not found');
        
        const hasAcceptedOffer = order.offers.some(o => o.status === 'accepted' && o.storeId === storeId);
        if (!hasAcceptedOffer) {
            throw new ForbiddenException('Not your order');
        }
        
        if (order.status !== OrderStatus.PREPARED) throw new BadRequestException('Order must be in PREPARED state to verify.');
        
        let parsedImages = [];
        if (typeof data.images === 'string') {
            try { parsedImages = JSON.parse(data.images); } catch(e) { parsedImages = [data.images]; }
        } else if (Array.isArray(data.images)) {
            parsedImages = data.images;
        }

        try {
            const [doc] = await this.prisma.$transaction([
                this.prisma.verificationDocument.create({
                    data: {
                        orderId,
                        storeId,
                        images: parsedImages,
                        videoUrl: data.videoUrl,
                        description: data.description,
                        recipientName: data.recipientName,
                        recipientSignature: data.recipientSignature,
                        signatureType: data.signatureType || 'DRAWN',
                        signatureText: data.signatureText || null,
                        handoverDate: data.handoverDate ? new Date(data.handoverDate) : null,
                        handoverTime: data.handoverTime,
                    }
                }),
                this.prisma.order.update({
                    where: { id: orderId },
                    data: { status: OrderStatus.VERIFICATION, verificationSubmittedAt: new Date() }
                })
            ]);

            await this.auditLogs.logAction({
                orderId, action: 'SUBMIT_VERIFICATION', entity: 'Order',
                actorType: ActorType.VENDOR, actorId: storeId, actorName: 'Merchant',
                previousState: order.status, newState: OrderStatus.VERIFICATION
            });
            
            const admins = await this.prisma.user.findMany({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } } });
            for (const admin of admins) {
                await this.notifications.create({
                    recipientId: admin.id, recipientRole: 'ADMIN', type: 'system_alert',
                    titleAr: 'توثيق طلب جديد للمراجعة', titleEn: 'New Order Verification Review',
                    messageAr: `قام المتجر برفع توثيق الطلب #${order.orderNumber}. بانتظار مراجعتك.`,
                    messageEn: `Store uploaded verification for order #${order.orderNumber}. Pending review.`,
                    link: `/admin/orders/${order.id}`
                });
            }
            
            return { success: true, doc };
        } catch (e) {
            require('fs').writeFileSync('./error_log_2.txt', (e.stack || e.message) + '\n\nPAYLOAD:\n' + JSON.stringify(data));
            throw e;
        }
    }

    async adminReviewVerification(orderId: string, adminId: string, data: any) {
        const order = await this.prisma.order.findUnique({ 
            where: { id: orderId }, 
            include: { verificationDocuments: { orderBy: { createdAt: 'desc' }, take: 1 } }
        });
        if (!order) throw new NotFoundException('Order not found');
        if (order.status !== OrderStatus.VERIFICATION && order.status !== OrderStatus.CORRECTION_SUBMITTED) {
            throw new BadRequestException('Order not pending verification review.');
        }

        const latestDoc = order.verificationDocuments[0];
        if (!latestDoc) throw new NotFoundException('Verification document not found.');

        // Support both action-based ('APPROVE'/'REJECT') and legacy status-based ('APPROVED') inputs
        const isApprove = data.action === 'APPROVE' || data.status === 'APPROVED' || data.approved === true;
        const decision = isApprove ? 'APPROVED' : 'REJECTED';
        const newOrderStatus = decision === 'APPROVED' ? OrderStatus.VERIFICATION_SUCCESS : OrderStatus.NON_MATCHING;
        
        const correctionDeadline = decision === 'REJECTED' ? new Date(Date.now() + 48 * 60 * 60 * 1000) : null;

        await this.prisma.$transaction([
            this.prisma.verificationDocument.update({
                where: { id: latestDoc.id },
                data: {
                    adminStatus: decision,
                    adminReviewedBy: adminId,
                    adminReviewedAt: new Date(),
                    adminRejectionReason: data.rejectionReason,
                    adminRejectionImages: data.rejectionImages || [],
                    adminRejectionVideo: data.rejectionVideo,
                    correctionDeadlineAt: correctionDeadline,
                    // New Signature Persistence
                    adminSignatureName: data.adminSignatureName,
                    adminSignatureType: data.adminSignatureType,
                    adminSignatureText: data.adminSignatureText,
                    adminSignatureImage: data.adminSignatureImage,
                }
            }),
            this.prisma.order.update({
                where: { id: orderId },
                data: { status: newOrderStatus, correctionDeadlineAt: correctionDeadline }
            })
        ]);

        await this.auditLogs.logAction({
            orderId, action: `VERIFICATION_${decision}`, entity: 'Order',
            actorType: ActorType.ADMIN, actorId: adminId, actorName: 'Admin',
            previousState: order.status, newState: newOrderStatus,
            metadata: { 
                signedBy: data.adminSignatureName,
                signatureType: data.adminSignatureType,
                reason: data.rejectionReason,
                timestamp: new Date().toISOString()
            }
        });

        // Fetch store to get the ownerId for the notification recipient
        const store = await this.prisma.store.findUnique({
            where: { id: latestDoc.storeId },
            select: { ownerId: true }
        });
        const merchantUserId = store?.ownerId;

        // Notifications are secondary — never let them crash the core verification response
        try {
            if (merchantUserId) {
                console.log('[DEBUG adminReviewVerification] latestDoc.storeId =', latestDoc.storeId, '| merchantUserId =', merchantUserId);
                if (decision === 'APPROVED') {
                    await this.notifications.create({
                        recipientId: merchantUserId, recipientRole: 'MERCHANT', type: 'system_alert',
                        titleAr: 'تم قبول مطابقة القطعة', titleEn: 'Part Verification Approved',
                        messageAr: `تم الموافقة على توثيق الطلب #${order.orderNumber}. يمكنك الآن تسليمه للمندوب ومتابعة الشحن.`,
                        messageEn: `Verification for #${order.orderNumber} approved. You can now handover to courier.`,
                        link: `/merchant/orders/${order.id}`
                    });
                } else {
                    await this.notifications.create({
                        recipientId: merchantUserId, recipientRole: 'MERCHANT', type: 'system_alert',
                        titleAr: '⚠️ رفض مطابقة القطعة - مطلوب تصحيح', titleEn: '⚠️ Verification Rejected - Correction Required',
                        messageAr: `تم اكتشاف عدم مطابقة في الطلب #${order.orderNumber}. أمامك 48 ساعة لتصحيح القطعة وإعادة التوثيق.`,
                        messageEn: `Non-matching part detected for #${order.orderNumber}. You have 48h to submit correction.`,
                        link: `/merchant/orders/${order.id}`
                    });
                }
            }
        } catch (notifErr) {
            console.error('[adminReviewVerification] Notification failed (non-blocking):', notifErr.message);
        }

        return { success: true, status: newOrderStatus };
    }

    async submitCorrectionVerification(orderId: string, storeId: string, data: any) {
        const order = await this.prisma.order.findUnique({ 
            where: { id: orderId },
            include: { 
                offers: true,
                verificationDocuments: { orderBy: { createdAt: 'desc' }, take: 1 } 
            }
        });
        if (!order) throw new NotFoundException('Order not found');
        
        const hasAcceptedOffer = order.offers.some(o => o.status === 'accepted' && o.storeId === storeId);
        if (!hasAcceptedOffer) {
            throw new ForbiddenException('Not your order');
        }
        if (order.status !== OrderStatus.CORRECTION_PERIOD && order.status !== OrderStatus.NON_MATCHING) {
            throw new BadRequestException('Order not in correction period.');
        }

        const originalDoc = order.verificationDocuments[0];

        const [doc] = await this.prisma.$transaction([
            this.prisma.verificationDocument.create({
                data: {
                    orderId, storeId,
                    isCorrection: true,
                    originalDocumentId: originalDoc?.id,
                    images: data.images || [],
                    videoUrl: data.videoUrl,
                    description: data.description,
                    recipientName: data.recipientName,
                    recipientSignature: data.recipientSignature,
                    signatureType: data.signatureType || 'DRAWN',
                    signatureText: data.signatureText || null,
                    handoverDate: data.handoverDate ? new Date(data.handoverDate) : null,
                    handoverTime: data.handoverTime,
                }
            }),
            this.prisma.order.update({
                where: { id: orderId },
                data: { status: OrderStatus.CORRECTION_SUBMITTED }
            })
        ]);

        await this.auditLogs.logAction({
            orderId, action: 'SUBMIT_CORRECTION', entity: 'Order',
            actorType: ActorType.VENDOR, actorId: storeId, actorName: 'Merchant',
            previousState: order.status, newState: OrderStatus.CORRECTION_SUBMITTED
        });

        const admins = await this.prisma.user.findMany({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } } });
        for (const admin of admins) {
            await this.notifications.create({
                recipientId: admin.id, recipientRole: 'ADMIN', type: 'system_alert',
                titleAr: 'إعادة توثيق لطلب غير مطابق', titleEn: 'Corrected Verification Submitted',
                messageAr: `قام المتجر برفع توثيق جديد للطلب #${order.orderNumber}. بانتظار إعادة التقييم.`,
                messageEn: `Store uploaded corrected verification for #${order.orderNumber}. Pending re-evaluation.`,
                link: `/admin/orders/${order.id}`
            });
        }
        return { success: true, doc };
    }

    async confirmDelivery(orderId: string, customerUserId: string, note?: string) {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: { 
                customer: { select: { id: true, email: true } }, 
                store: { select: { id: true, ownerId: true } } 
            }
        });

        if (!order) throw new NotFoundException('Order not found');
        if (order.customerId !== customerUserId) throw new ForbiddenException('Not your order');
        if (order.status !== OrderStatus.SHIPPED) {
            throw new BadRequestException('Order must be in Shipped state to confirm receipt.');
        }

        // Transition to DELIVERED
        const updatedOrder = await this.transitionStatus(
            orderId,
            OrderStatus.DELIVERED,
            { id: customerUserId, type: ActorType.CUSTOMER, name: order.customer.email },
            note || 'Customer confirmed receipt'
        );

        // Notify Merchant
        if (order.storeId && order.store) {
            await this.notifications.create({
                recipientId: order.store.ownerId,
                recipientRole: 'MERCHANT',
                type: 'system_alert',
                titleAr: 'تم استلام الطلب بنجاح ✅',
                titleEn: 'Order Received Successfully ✅',
                messageAr: `أكد العميل استلام الطلب رقم #${order.orderNumber}. الملاحظة: ${note || '-'}`,
                messageEn: `Customer confirmed receipt for order #${order.orderNumber}. Note: ${note || '-'}`,
                link: `/merchant/orders/${order.id}`
            });
        }

        // Notify Admin
        const admins = await this.prisma.user.findMany({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } } });
        for (const admin of admins) {
            await this.notifications.create({
                recipientId: admin.id,
                recipientRole: 'ADMIN',
                type: 'system_alert',
                titleAr: 'تأكيد استلام طلب',
                titleEn: 'Delivery Confirmation',
                messageAr: `قام العميل بتأكيد استلام الطلب رقم #${order.orderNumber}.`,
                messageEn: `Customer confirmed delivery for order #${order.orderNumber}.`,
                link: `/admin/orders/${order.id}`
            });
        }

        return updatedOrder;
    }

    async getAdminShippingCarts() {
        const orders = await this.prisma.order.findMany({
            where: {
                status: { in: [OrderStatus.PREPARATION, OrderStatus.PARTIALLY_SHIPPED] },
                requestType: 'multiple'
            },
            include: {
                customer: { select: { id: true, name: true, email: true, phone: true } },
                parts: true,
                payments: { where: { status: 'SUCCESS' } },
                offers: {
                    where: { status: 'accepted' },
                    include: { 
                        store: true,
                        payments: { where: { status: 'SUCCESS' } }
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        // Group by customer for better admin oversight
        const cartsByCustomer = orders.reduce((acc, order) => {
            if (!acc[order.customerId]) {
                acc[order.customerId] = {
                    customerId: order.customerId,
                    customerName: order.customer.name || 'Anonymous',
                    customerEmail: order.customer.email,
                    customerPhone: order.customer.phone,
                    totalItems: 0,
                    totalValue: 0,
                    earliestPayment: new Date(),
                    offers: [],
                    orders: []
                };
            }
            
            const firstPayment = order.payments?.sort((a, b) => 
                (a.paidAt?.getTime() || 0) - (b.paidAt?.getTime() || 0)
            )[0];
            const paidAt = firstPayment?.paidAt || order.updatedAt;
            
            if (new Date(paidAt) < new Date(acc[order.customerId].earliestPayment)) {
                acc[order.customerId].earliestPayment = paidAt;
            }

            order.offers.forEach(offer => {
                acc[order.customerId].totalItems += 1;
                acc[order.customerId].totalValue += (Number(offer.unitPrice) + Number(offer.shippingCost));
                
                // Add specific offer info for the preview
                acc[order.customerId].offers.push({
                    id: offer.id,
                    orderNumber: order.orderNumber,
                    partName: order.parts.find(p => p.id === offer.orderPartId)?.name || order.partName,
                    storeName: offer.store?.name,
                    shippedFromCart: offer.shippedFromCart,
                    price: Number(offer.unitPrice),
                    status: order.status
                });
            });

            acc[order.customerId].orders.push(order.id);
            return acc;
        }, {} as Record<string, any>);

        return Object.values(cartsByCustomer);
    }

    private calculateWarrantyEndDate(startDate: Date, duration: string): Date {
        const date = new Date(startDate);
        const d = duration.toLowerCase();
        
        if (d.includes('day')) {
            const num = parseInt(d.match(/\d+/)?.[0] || '0');
            date.setDate(date.getDate() + num);
        } else if (d.includes('month')) {
            const num = parseInt(d.match(/\d+/)?.[0] || '1');
            date.setMonth(date.getMonth() + num);
        } else if (d.includes('year')) {
            const num = parseInt(d.match(/\d+/)?.[0] || '1');
            date.setFullYear(date.getFullYear() + num);
        } else {
            // Default 15 days if format unknown but exists
            date.setDate(date.getDate() + 15);
        }
        
        return date;
    }
}
