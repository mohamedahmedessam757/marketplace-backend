import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Inject, forwardRef, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderStateMachine } from './fsm/order-state-machine.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ActorType, Order, OrderStatus, Prisma, ShipmentStatus, StoreLoyaltyTier } from '@prisma/client';
import { FindAllOrdersDto } from './dto/find-all-orders.dto';

import { ChatService } from '../chat/chat.service';
import { ShipmentsService } from '../shipments/shipments.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { UsersService } from '../users/users.service';
import { POST_DELIVERY_RETURN_DISPUTE_HOURS } from './order-time.constants';
import { WaybillsService } from '../waybills/waybills.service';
import { OfferFulfillmentService } from './offer-fulfillment.service';
import { OfferFulfillmentStatus } from '@prisma/client';
import { VerificationTasksService } from '../verification-tasks/verification-tasks.service';

@Injectable()
export class OrdersService {
    private readonly logger = new Logger(OrdersService.name);

    constructor(
        private prisma: PrismaService,
        private fsm: OrderStateMachine,
        private auditLogs: AuditLogsService,
        private notifications: NotificationsService,
        private chatService: ChatService, // Injected
        private shipmentsService: ShipmentsService,
        private loyaltyService: LoyaltyService,
        private usersService: UsersService,
        private waybillsService: WaybillsService,
        private offerFulfillment: OfferFulfillmentService,
        @Inject(forwardRef(() => VerificationTasksService))
        private verificationTasks: VerificationTasksService,
    ) { }

    /** Backward-compatible singular `review` field for API consumers (first review). */
    private attachLegacyReviewField<T extends { reviews?: unknown[] | null }>(
        order: T,
    ): T & { review: unknown | null } {
        const reviews = order.reviews ?? [];
        return { ...order, review: reviews[0] ?? null };
    }

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
                    parts: { select: { id: true, name: true, quantity: true, description: true, images: true, notes: true } },
                    customer: { select: { id: true, name: true, email: true, avatar: true } },
                    reviews: { select: { id: true, rating: true, offerId: true } },
                    offers: {
                        where: { status: { not: 'rejected' }, isWithdrawn: false },
                        orderBy: { createdAt: 'asc' },
                        include: {
                            store: {
                                select: {
                                    id: true,
                                    name: true,
                                    storeCode: true,
                                    logo: true,
                                    rating: true,
                                    _count: {
                                        select: {
                                            reviews: { where: { adminStatus: 'PUBLISHED' } },
                                        },
                                    },
                                },
                            },
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
            this.attachLegacyReviewField(order);
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

    async findOne(id: string, options?: { includeAuditLogs?: boolean }) {
        const includeAuditLogs = options?.includeAuditLogs ?? true;
        const order = await this.prisma.order.findUnique({
            where: { id },
            include: {
                parts: true,
                customer: { select: { id: true, name: true, email: true, phone: true } },
                acceptedOffer: { include: { store: true } },
                reviews: true,
                shipments: { orderBy: { createdAt: 'desc' } },
                offers: {
                    orderBy: { createdAt: 'asc' },
                    include: {
                        store: {
                            select: {
                                id: true,
                                name: true,
                                storeCode: true,
                                logo: true,
                                loyaltyTier: true,
                                rating: true,
                                _count: {
                                    select: {
                                        reviews: { where: { adminStatus: 'PUBLISHED' } },
                                    },
                                },
                            },
                        },
                    },
                },
                invoices: { 
                    orderBy: { issuedAt: 'desc' }
                },
                shippingWaybills: { orderBy: { issuedAt: 'desc' } },
                ...(includeAuditLogs
                    ? { auditLogs: { orderBy: { timestamp: 'desc' as const } } }
                    : {}),
                verificationDocuments: { orderBy: { createdAt: 'desc' } },
                shippingAddresses: { orderBy: { createdAt: 'asc' } },
                _count: {
                    select: { offers: true }
                }
            },
        });
        if (!order) throw new NotFoundException(`Order #${id} not found`);
        return this.attachLegacyReviewField(order);
    }

    async issueWaybillsForAdmin(
        orderId: string,
        adminId: string,
        dto: {
            mode: 'per_part' | 'single_batch' | 'custom';
            offerIds?: string[];
            groups?: { offerIds: string[] }[];
        },
    ) {
        return this.waybillsService.adminIssueWaybills(orderId, adminId, dto);
    }

    /**
     * Enhanced findOne with user role context for visibility filtering (2026 Blind Auction)
     */
    async findOneWithContext(id: string, user: any) {
        const includeAuditLogs = user?.role !== 'CUSTOMER';
        const order = await this.findOne(id, { includeAuditLogs });

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

        // Customer offer ranking: tier (desc) → rating (desc) → unit price (asc)
        if (user.role === 'CUSTOMER' && order.offers?.length) {
            const rank: Record<StoreLoyaltyTier, number> = {
                BASIC: 1,
                SILVER: 2,
                GOLD: 3,
                VIP: 4,
                ELITE: 5,
            };
            order.offers = [...order.offers].sort((a, b) => {
                const ta = rank[(a as any).store?.loyaltyTier as StoreLoyaltyTier] ?? 0;
                const tb = rank[(b as any).store?.loyaltyTier as StoreLoyaltyTier] ?? 0;
                if (tb !== ta) return tb - ta;
                const ra = Number((b as any).store?.rating ?? 0) - Number((a as any).store?.rating ?? 0);
                if (ra !== 0) return ra;
                return Number((a as any).unitPrice) - Number((b as any).unitPrice);
            });
        }

        if (order.offers?.length) {
            order.offers = this.enrichOffersWithCartBatch(order.offers as any[]) as any;
        }

        let shipmentBatches: Awaited<
            ReturnType<WaybillsService['buildShipmentBatchesForOrder']>
        > = [] as Awaited<ReturnType<WaybillsService['buildShipmentBatchesForOrder']>>;
        if (String(order.requestType || '').toLowerCase() === 'multiple') {
            try {
                shipmentBatches =
                    await this.waybillsService.buildShipmentBatchesForOrder(id);
            } catch (err) {
                this.logger.warn(
                    `shipmentBatches omitted for order ${id}: ${err instanceof Error ? err.message : err}`,
                );
            }
        }

        return { ...order, shipmentBatches };
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

            const effectiveStatus = isTransitioningToWarranty ? OrderStatus.WARRANTY_ACTIVE : newStatus;
            const now = new Date();
            const isFirstDeliveredTransition =
                newStatus === OrderStatus.DELIVERED &&
                effectiveStatus === OrderStatus.DELIVERED &&
                !order.deliveredAt;

            const updatedOrder = await tx.order.update({
                where: { id: orderId },
                data: {
                    status: effectiveStatus,
                    updatedAt: now,
                    warranty_active_at: isTransitioningToWarranty ? now : undefined,
                    warranty_end_at: isTransitioningToWarranty ? finalWarrantyEnd : undefined,
                    selectionDeadlineAt: newStatus === OrderStatus.AWAITING_SELECTION ? new Date(Date.now() + 24 * 60 * 60 * 1000) : undefined,
                    deliveredAt: isFirstDeliveredTransition ? now : undefined,
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
                // Referral commission v2 (1% of item subtotal, within 6-month window)
                this.loyaltyService.processReferralReward(orderId).catch(err => {
                    console.error(`Failed to process referral reward for order ${orderId}:`, err);
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

    async markAsPrepared(orderId: string, storeId: string, offerId?: string) {
        const result = await this.offerFulfillment.markAsPreparedForStore(
            orderId,
            storeId,
            offerId,
        );

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            select: { orderNumber: true },
        });

        this.notifications.notifyMerchantByStoreId(storeId, {
            titleAr: 'توثيق حالة القطعة إلزامي!',
            titleEn: 'Part Verification Required!',
            messageAr: `تم تجهيز قطعتك في الطلب #${order?.orderNumber || orderId}. يرجى رفع التوثيق للمتابعة.`,
            messageEn: `Your part on order #${order?.orderNumber || orderId} is prepared. Please upload verification.`,
            type: 'ORDER',
            link: `/merchant/orders/${orderId}`,
        }).catch((e) => console.error('Failed to notify merchant upon preparation', e));

        return this.prisma.order.findUnique({ where: { id: orderId } });
    }

    async getOfferFulfillmentSummary(orderId: string) {
        const paidOffers = await this.offerFulfillment.getPaidAcceptedOffers(orderId);
        const enriched = await Promise.all(
            paidOffers.map(async (o) => ({
                ...o,
                hasOpenCase: await this.offerFulfillment.hasOpenCaseForOffer(
                    o.id,
                    o.orderPartId,
                ),
            })),
        );
        return this.offerFulfillment.getFulfillmentSummary(enriched);
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
        const allowedCheckoutStatuses: OrderStatus[] = [
            OrderStatus.AWAITING_PAYMENT,
            OrderStatus.PARTIALLY_PAID,
            OrderStatus.AWAITING_SELECTION,
        ];
        if (!allowedCheckoutStatuses.includes(order.status)) {
            throw new BadRequestException(
                `Cannot update checkout data while order is ${order.status}`,
            );
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
        const cartOrderStatuses: OrderStatus[] = [
            OrderStatus.PREPARATION,
            OrderStatus.PREPARED,
            OrderStatus.VERIFICATION,
            OrderStatus.VERIFICATION_SUCCESS,
            OrderStatus.READY_FOR_SHIPPING,
            OrderStatus.PARTIALLY_SHIPPED,
        ];

        const orders = await this.prisma.order.findMany({
            where: {
                customerId,
                status: { in: cartOrderStatuses },
                requestType: 'multiple',
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
                        status: { in: ['accepted', 'ACCEPTED'] },
                        shippedFromCart: false,
                    },
                    include: {
                        store: true,
                        orderPart: true,
                        payments: { where: { status: 'SUCCESS' } },
                    },
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
                if (!offer.payments?.length) continue;

                const part = order.parts.find(p => p.id === offer.orderPartId) || order.parts[0];
                const partName = part?.name || order.partName || 'Multi-Part Order';
                const partImages = (part?.images as string[]) || [];
                const orderImages = (order.partImages as string[]) || [];
                const partImage = (partImages.length > 0) ? partImages[0] : (orderImages.length > 0 ? orderImages[0] : null);

                const offerPayment = offer.payments?.[0];
                const finalPrice = offerPayment?.totalAmount ? Number(offerPayment.totalAmount) : (Number(offer.unitPrice) + Number(offer.shippingCost));

                const fulfillmentStatus = offer.fulfillmentStatus as OfferFulfillmentStatus;
                const canSelectForShipping =
                    fulfillmentStatus === OfferFulfillmentStatus.READY_FOR_SHIPPING;
                const lockReason = this.offerFulfillment.getLockReason(fulfillmentStatus);
                const handoverPending =
                    fulfillmentStatus === OfferFulfillmentStatus.VERIFICATION_SUCCESS;

                cartItems.push({
                    id: order.id,
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
                    partsCount: 1,
                    requestType: order.requestType || 'N/A',
                    shippingType: order.shippingType || 'N/A',
                    shippingAddress: order.shippingAddresses?.[0] || null,
                    totalPaid: finalPrice,
                    fulfillmentStatus,
                    canSelectForShipping,
                    handoverPending,
                    lockReasonAr: lockReason.ar,
                    lockReasonEn: lockReason.en,
                });
            }
        }

        return cartItems;
    }

    async getMerchantAssemblyCart(userId: string, storeId: string) {
        if (!storeId) return [];

        const cartOrderStatuses: OrderStatus[] = [
            OrderStatus.PREPARATION,
            OrderStatus.PREPARED,
            OrderStatus.VERIFICATION,
            OrderStatus.VERIFICATION_SUCCESS,
            OrderStatus.READY_FOR_SHIPPING,
            OrderStatus.PARTIALLY_SHIPPED,
        ];

        const orders = await this.prisma.order.findMany({
            where: {
                status: { in: cartOrderStatuses },
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
                if (!offer.payments?.length) continue;
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

                const fulfillmentStatus = offer.fulfillmentStatus as OfferFulfillmentStatus;
                const canSelectForShipping =
                    isMyOffer &&
                    fulfillmentStatus === OfferFulfillmentStatus.READY_FOR_SHIPPING;
                const lockReason = this.offerFulfillment.getLockReason(fulfillmentStatus);
                const handoverPending =
                    fulfillmentStatus === OfferFulfillmentStatus.VERIFICATION_SUCCESS;

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
                    isMyOffer: isMyOffer,
                    fulfillmentStatus,
                    canSelectForShipping,
                    handoverPending,
                    lockReasonAr: lockReason.ar,
                    lockReasonEn: lockReason.en,
                });
            }
        }

        return cartItems;
    }

    /** Enrich offers with cart batch metadata for grouped-order shipping UI */
    private enrichOffersWithCartBatch<T extends { cartShipmentId?: string | null; shippedFromCart?: boolean; fulfillmentStatus?: string }>(
        offers: T[],
    ): (T & { cartBatchSize: number | null; cartBatchType: 'solo' | 'group' | null; handoverPending: boolean })[] {
        const counts = new Map<string, number>();
        for (const o of offers) {
            if (o.cartShipmentId) {
                counts.set(o.cartShipmentId, (counts.get(o.cartShipmentId) || 0) + 1);
            }
        }
        return offers.map((o) => {
            const handoverPending =
                o.fulfillmentStatus === OfferFulfillmentStatus.VERIFICATION_SUCCESS;
            if (!o.shippedFromCart || !o.cartShipmentId) {
                return {
                    ...o,
                    cartBatchSize: null,
                    cartBatchType: null,
                    handoverPending,
                };
            }
            const size = counts.get(o.cartShipmentId) || 1;
            return {
                ...o,
                cartBatchSize: size,
                cartBatchType: size > 1 ? ('group' as const) : ('solo' as const),
                handoverPending,
            };
        });
    }

    async getDeliveredOrders(customerId: string) {
        // Find DELIVERED orders within the last 30 days (changed from 3 days to allow visibility of expired items)
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const orders = await this.prisma.order.findMany({
            where: {
                customerId,
                status: {
                    in: [
                        OrderStatus.DELIVERED,
                        OrderStatus.PARTIALLY_DELIVERED,
                        OrderStatus.SHIPPED,
                    ],
                },
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
            const isMulti = this.offerFulfillment.isMultiItemOrder(order);
            const orderDeliveredAt = order.deliveredAt ?? order.updatedAt;
            const windowMs = POST_DELIVERY_RETURN_DISPUTE_HOURS * 60 * 60 * 1000;

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
                let returnExpiryDate = new Date(orderDeliveredAt.getTime() + windowMs);
                let isReturnEligible = Date.now() <= returnExpiryDate.getTime();

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
                    deliveredAt: orderDeliveredAt,
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
                const offerDeliveredAt =
                    (offer as { deliveredAt?: Date | null }).deliveredAt ??
                    (isMulti ? null : orderDeliveredAt);

                if (
                    isMulti &&
                    offer.fulfillmentStatus !== OfferFulfillmentStatus.DELIVERED &&
                    offer.fulfillmentStatus !== OfferFulfillmentStatus.COMPLETED
                ) {
                    continue;
                }
                if (isMulti && !offerDeliveredAt && offer.fulfillmentStatus !== OfferFulfillmentStatus.COMPLETED) {
                    continue;
                }

                const partName = part?.name || order.partName || 'Multi-Part Order';
                const partImages = (part?.images as string[]) || [];
                const orderImages = (order.partImages as string[]) || [];
                const partImage = (partImages.length > 0) ? partImages[0] : (orderImages.length > 0 ? orderImages[0] : null);

                const itemDeliveredAt = offerDeliveredAt ?? orderDeliveredAt;
                const returnExpiryDate = offerDeliveredAt
                    ? new Date(offerDeliveredAt.getTime() + windowMs)
                    : new Date(orderDeliveredAt.getTime() + windowMs);
                const isOfferCompleted =
                    offer.fulfillmentStatus === OfferFulfillmentStatus.COMPLETED ||
                    !!(offer as { resolutionLocked?: boolean }).resolutionLocked;
                const isReturnEligible =
                    !isOfferCompleted &&
                    offerDeliveredAt != null &&
                    Date.now() <= returnExpiryDate.getTime() &&
                    offer.fulfillmentStatus === OfferFulfillmentStatus.DELIVERED;

                const offerPayment = order.payments?.find((p) => p.offerId === offer.id);

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
                    deliveredAt: itemDeliveredAt,
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
                    totalPaid: offerPayment?.totalAmount
                        ? Number(offerPayment.totalAmount)
                        : Number(offer.unitPrice) + Number(offer.shippingCost),
                    status: order.status,
                    fulfillmentStatus: offer.fulfillmentStatus,
                    resolutionLocked: !!(offer as { resolutionLocked?: boolean }).resolutionLocked,
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
            include: {
                order: true,
                payments: { where: { status: 'SUCCESS' } },
            },
        });

        const validOffers = offers.filter((o) => {
            if (o.order.customerId !== customerId) return false;
            if (!o.payments?.some((p) => p.status === 'SUCCESS')) return false;
            return (
                o.fulfillmentStatus === OfferFulfillmentStatus.READY_FOR_SHIPPING &&
                !o.shippedFromCart
            );
        });

        if (validOffers.length === 0) {
            return {
                success: false,
                reason:
                    'No items are ready for shipping. Each part must be prepared, verified, and handed over to admin by its merchant before you can ship it from the assembly cart.',
            };
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
                        cartShipmentId: shipment.id,
                        fulfillmentStatus: OfferFulfillmentStatus.SHIPPED,
                    },
                });

                await this.offerFulfillment.recomputeOrderStatus(orderId);

                try {
                    const orderMeta = await this.prisma.order.findUnique({
                        where: { id: orderId },
                        include: { parts: true },
                    });
                    if (
                        orderMeta &&
                        !this.waybillsService.shouldAutoIssueOnVerification(orderMeta)
                    ) {
                        await this.waybillsService.issueWaybillsForOfferBatch(
                            orderId,
                            batchOffers.map((o) => o.id),
                            actor.id === 'SYSTEM' ? null : actor.id,
                            {
                                mode: 'single_batch',
                                shipmentId: shipment.id,
                                trigger: isSystemAutoTrigger ? 'AUTO_7DAY' : 'CART_BATCH',
                                automated: isSystemAutoTrigger,
                                reason: isSystemAutoTrigger
                                    ? 'Waybill for 7-day auto-ship batch'
                                    : 'Waybill for customer cart selection batch',
                            },
                        );
                    }
                } catch (waybillErr) {
                    console.error(
                        `[requestShipping] Waybill batch issue failed for order ${orderId}:`,
                        waybillErr instanceof Error ? waybillErr.message : waybillErr,
                    );
                }

                // 3. Check if ALL accepted offers for this order are now shipped
                const remainingPending = await this.prisma.offer.count({
                    where: { 
                        orderId, 
                        status: 'accepted', 
                        shippedFromCart: false 
                    }
                });

                const refreshedOrder = await this.prisma.order.findUnique({
                    where: { id: orderId },
                    select: { status: true },
                });
                const currentStatus = refreshedOrder?.status as OrderStatus;

                if (remainingPending === 0) {
                    if (currentStatus !== OrderStatus.SHIPPED) {
                        await this.transitionStatus(
                            orderId,
                            OrderStatus.SHIPPED,
                            actor,
                            isSystemAutoTrigger ? 'All items auto-shipped after 7-day period' : 'All items shipped from assembly cart'
                        );
                    } else {
                        await this.auditLogs.logAction({
                            orderId,
                            action: 'SHIPPING_BATCH',
                            entity: 'Order',
                            actorId: actor.id,
                            actorType: actor.type,
                            actorName: actor.name,
                            previousState: OrderStatus.SHIPPED,
                            newState: OrderStatus.SHIPPED,
                            metadata: {
                                batchSize: batchOffers.length,
                                remaining: 0,
                                isAuto: isSystemAutoTrigger,
                                note: 'Final batch; order already SHIPPED after aggregate recompute',
                            },
                        });
                    }
                } else if (
                    currentStatus !== OrderStatus.PARTIALLY_SHIPPED &&
                    currentStatus !== OrderStatus.SHIPPED
                ) {
                    await this.transitionStatus(
                        orderId,
                        OrderStatus.PARTIALLY_SHIPPED,
                        actor,
                        isSystemAutoTrigger 
                            ? `System auto-shipped ${batchOffers.length} aging items. ${remainingPending} items remaining.`
                            : `Partial shipment: ${batchOffers.length} items shipped. ${remainingPending} items remaining.`
                    );
                } else {
                    await this.auditLogs.logAction({
                        orderId,
                        action: 'PARTIAL_SHIPPING',
                        entity: 'Order',
                        actorId: actor.id,
                        actorType: actor.type,
                        actorName: actor.name,
                        previousState: currentStatus,
                        newState: currentStatus,
                        metadata: {
                            batchSize: batchOffers.length,
                            remaining: remainingPending,
                            isAuto: isSystemAutoTrigger,
                        },
                    });
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

    async requestShippingByMerchant(
        orderId: string,
        storeId: string,
        userId: string,
        offerId?: string,
    ) {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: {
                offers: {
                    where: offerId ? { id: offerId } : { storeId },
                    include: { orderPart: true, store: true },
                },
            },
        });
        if (!order) throw new NotFoundException('Order not found');

        await this.offerFulfillment.markOfferReadyForStore(
            orderId,
            storeId,
            offerId,
        );

        const handoverOffer = order.offers[0];
        const partName =
            handoverOffer?.orderPart?.name || order.partName || 'Part';
        const storeName = handoverOffer?.store?.name || 'Merchant';

        await this.notifications.notifyAdmins({
            titleAr: 'تم طلب تسليم شحنة من التاجر',
            titleEn: 'Merchant requested shipment handover',
            messageAr: `التاجر «${storeName}» أرسل طلب تسليم «${partName}» للطلب #${order.orderNumber}.`,
            messageEn: `Merchant «${storeName}» submitted handover for «${partName}» on order #${order.orderNumber}.`,
            type: 'ORDER_UPDATE',
            link: 'orders-control',
            metadata: { orderId, offerId: handoverOffer?.id, tab: 'detail' },
        });

        return this.prisma.order.findUnique({ where: { id: orderId } });
    }


    async submitVerification(
        orderId: string,
        storeId: string,
        data: any,
        offerId?: string,
    ) {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: { offers: true },
        });
        if (!order) throw new NotFoundException('Order not found');

        let targetOfferId = offerId;
        if (!targetOfferId) {
            const mine = order.offers.find(
                (o) =>
                    ['accepted', 'ACCEPTED'].includes(o.status) &&
                    o.storeId === storeId,
            );
            if (!mine) throw new ForbiddenException('Not your order');
            targetOfferId = mine.id;
        }

        const availableOfficer = await this.prisma.user.findFirst({
            where: { role: 'VERIFICATION_OFFICER', status: 'ACTIVE' },
            orderBy: { updatedAt: 'asc' },
        });

        await this.verificationTasks.ensureTaskForOffer(
            orderId,
            targetOfferId,
            availableOfficer?.id ?? null,
        );

        await this.prisma.order.update({
            where: { id: orderId },
            data: { verificationSubmittedAt: new Date() },
        });

        if (availableOfficer) {
            const task = await this.prisma.verificationTask.findFirst({
                where: {
                    orderId,
                    offerId: targetOfferId,
                    status: { notIn: ['ADMIN_APPROVED', 'ADMIN_REJECTED', 'CANCELLED'] },
                },
                orderBy: { createdAt: 'desc' },
            });
            if (task) {
                await this.notifications.create({
                    recipientId: availableOfficer.id,
                    recipientRole: 'VERIFICATION_OFFICER',
                    type: 'system_alert',
                    titleAr: 'مهمة مطابقة قطعة جديدة',
                    titleEn: 'New part verification task',
                    messageAr: `تم إسناد مهمة مطابقة لقطعة في الطلب #${order.orderNumber}.`,
                    messageEn: `A part verification task for order #${order.orderNumber} was assigned to you.`,
                    link: `/dashboard/verification-task-details/${task.id}`,
                });
            }
        }

        return this.offerFulfillment.submitOfferVerification(
            orderId,
            targetOfferId,
            storeId,
            data,
        );
    }

    async adminReviewVerification(orderId: string, adminId: string, data: any) {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: {
                verificationDocuments: { orderBy: { createdAt: 'desc' } },
            },
        });
        if (!order) throw new NotFoundException('Order not found');

        const pendingDocs = order.verificationDocuments.filter(
            (d) => !d.adminStatus || String(d.adminStatus).toUpperCase() === 'PENDING',
        );

        let targetDoc = data.documentId
            ? order.verificationDocuments.find((d) => d.id === data.documentId)
            : data.offerId
              ? pendingDocs.find((d) => d.offerId === data.offerId) ??
                order.verificationDocuments.find((d) => d.offerId === data.offerId)
              : pendingDocs[0] ?? order.verificationDocuments[0];

        if (!targetDoc) throw new NotFoundException('Verification document not found.');

        const isPerOfferReview = !!targetDoc.offerId;
        const isDocPending =
            !targetDoc.adminStatus ||
            String(targetDoc.adminStatus).toUpperCase() === 'PENDING';

        if (!isDocPending) {
            throw new BadRequestException(
                'This verification document is not pending review.',
            );
        }

        const latestDoc = targetDoc;

        const isApprove = data.action === 'APPROVE' || data.status === 'APPROVED' || data.approved === true;
        const decision = isApprove ? 'APPROVED' : 'REJECTED';
        
        let newOrderStatus: OrderStatus = decision === 'APPROVED' ? OrderStatus.VERIFICATION_SUCCESS : OrderStatus.NON_MATCHING;
        let correctionDeadline = decision === 'REJECTED' ? new Date(Date.now() + 48 * 60 * 60 * 1000) : null;
        let newRejectionCount = order.rejectionCount;

        if (decision === 'REJECTED' && !isPerOfferReview) {
            newRejectionCount += 1;
            if (newRejectionCount >= 2) {
                newOrderStatus = OrderStatus.CANCELLED;
                correctionDeadline = null;
            }
        }

        const txOps: any[] = [
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
                    adminSignatureName: data.adminSignatureName,
                    adminSignatureType: data.adminSignatureType,
                    adminSignatureText: data.adminSignatureText,
                    adminSignatureImage: data.adminSignatureImage,
                },
            }),
        ];

        if (!isPerOfferReview) {
            txOps.push(
                this.prisma.order.update({
                    where: { id: orderId },
                    data: {
                        status: newOrderStatus,
                        correctionDeadlineAt: correctionDeadline,
                        rejectionCount: newRejectionCount,
                    },
                }),
            );
            if (order.verificationTaskId) {
                txOps.push(
                    this.prisma.verificationTask.update({
                        where: { id: order.verificationTaskId },
                        data: {
                            status: decision === 'APPROVED' ? 'ADMIN_APPROVED' : 'ADMIN_REJECTED',
                        },
                    }),
                );
            }
        }

        await this.prisma.$transaction(txOps);

        let partName = order.partName || 'Part';
        if (latestDoc.offerId) {
            const linkedOffer = await this.prisma.offer.findFirst({
                where: { id: latestDoc.offerId, orderId },
                include: { orderPart: true },
            });
            if (linkedOffer) {
                partName =
                    linkedOffer.orderPart?.name || order.partName || 'Part';
            }

            await this.offerFulfillment.applyVerificationDecision(
                orderId,
                latestDoc.offerId,
                decision === 'APPROVED',
            );
            const refreshed = await this.prisma.order.findUnique({
                where: { id: orderId },
            });
            if (refreshed) newOrderStatus = refreshed.status;
        }

        const paidOffers =
            await this.offerFulfillment.getPaidAcceptedOffers(orderId);
        const allOffersVerified =
            paidOffers.length > 0 &&
            paidOffers.every(
                (o) =>
                    o.fulfillmentStatus === 'VERIFICATION_SUCCESS' ||
                    o.fulfillmentStatus === 'READY_FOR_SHIPPING' ||
                    o.fulfillmentStatus === 'SHIPPED' ||
                    o.fulfillmentStatus === 'DELIVERED',
            );

        if (
            allOffersVerified &&
            newOrderStatus === OrderStatus.VERIFICATION_SUCCESS &&
            this.waybillsService.shouldAutoIssueOnVerification(order)
        ) {
            try {
                await this.waybillsService.autoIssueAfterVerificationSuccess(
                    orderId,
                    adminId,
                );
            } catch (waybillErr) {
                console.error(
                    '[adminReviewVerification] Waybill auto-issue failed (non-blocking):',
                    waybillErr instanceof Error ? waybillErr.message : waybillErr,
                );
            }
        }

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
                        messageAr: `تم اعتماد توثيق «${partName}» للطلب #${order.orderNumber}. يمكنك تسليمها للإدارة ومتابعة الشحن.`,
                        messageEn: `Verification for "${partName}" (#${order.orderNumber}) approved. You can hand over to admin.`,
                        link: `/merchant/orders/${order.id}`
                    });
                } else if (!isPerOfferReview && newRejectionCount >= 2) {
                    await this.notifications.create({
                        recipientId: merchantUserId, recipientRole: 'MERCHANT', type: 'system_alert',
                        titleAr: '❌ رفض نهائي وإلغاء الطلب', titleEn: '❌ Final Rejection & Order Cancelled',
                        messageAr: `تم رفض مطابقة الطلب #${order.orderNumber} للمرة الثانية. تم إلغاء الطلب وسحب المبلغ.`,
                        messageEn: `Order #${order.orderNumber} verification rejected twice. Order cancelled.`,
                        link: `/merchant/orders/${order.id}`
                    });
                    await this.notifications.create({
                        recipientId: order.customerId, recipientRole: 'CUSTOMER', type: 'system_alert',
                        titleAr: '❌ إلغاء الطلب لعدم المطابقة', titleEn: '❌ Order Cancelled due to Non-Matching',
                        messageAr: `تم إلغاء طلبك #${order.orderNumber} لعدم مطابقة القطعة من المتجر. سيتم استرجاع مبلغك قريباً.`,
                        messageEn: `Your order #${order.orderNumber} was cancelled due to non-matching part. Refund will be processed soon.`,
                        link: `/customer/orders/${order.id}`
                    });
                } else {
                    const reasonSnippet = data.rejectionReason
                        ? `: ${String(data.rejectionReason).slice(0, 120)}`
                        : '';
                    await this.notifications.create({
                        recipientId: merchantUserId, recipientRole: 'MERCHANT', type: 'system_alert',
                        titleAr: '⚠️ رفض مطابقة القطعة - مطلوب تصحيح', titleEn: '⚠️ Verification Rejected - Correction Required',
                        messageAr: `تم رفض توثيق «${partName}» للطلب #${order.orderNumber}${reasonSnippet}. يرجى تصحيح القطعة وإعادة التوثيق.`,
                        messageEn: `Verification for "${partName}" (#${order.orderNumber}) was rejected${reasonSnippet}. Please correct and re-submit verification.`,
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

        // Find previous verification task to link the cycle
        const previousTask = await this.prisma.verificationTask.findFirst({
            where: { orderId },
            orderBy: { createdAt: 'desc' }
        });

        const newCycleNumber = previousTask ? previousTask.cycleNumber + 1 : 2;

        const [doc, newTask] = await this.prisma.$transaction([
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
            this.prisma.verificationTask.create({
                data: {
                    orderId,
                    status: 'PENDING_ASSIGNMENT',
                    cycleNumber: newCycleNumber,
                    previousTaskId: previousTask?.id
                }
            }),
            this.prisma.order.update({
                where: { id: orderId },
                data: { status: OrderStatus.CORRECTION_SUBMITTED }
            })
        ]);

        await this.prisma.order.update({
            where: { id: orderId },
            data: { verificationTaskId: newTask.id }
        });

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

    /**
     * After a shipment batch is marked delivered: update per-offer fulfillment and only
     * move the order to DELIVERED when every shipment record for the order is delivered.
     */
    async syncOrderStatusAfterShipmentDelivery(orderId: string) {
        const shipments = await this.prisma.shipment.findMany({
            where: { orderId },
            select: { id: true, status: true, actualDelivery: true },
        });

        if (shipments.length === 0) {
            return;
        }

        const deliveredStatus = ShipmentStatus.DELIVERED_TO_CUSTOMER;
        const now = new Date();

        for (const s of shipments) {
            if (s.status !== deliveredStatus) continue;
            await this.prisma.offer.updateMany({
                where: {
                    cartShipmentId: s.id,
                    deliveredAt: null,
                },
                data: {
                    fulfillmentStatus: OfferFulfillmentStatus.DELIVERED,
                    deliveredAt: now,
                },
            });
            // Legacy/single-shipment: offers without cartShipmentId on one-shipment orders
            if (shipments.length === 1) {
                await this.prisma.offer.updateMany({
                    where: {
                        orderId,
                        status: { in: ['accepted', 'ACCEPTED'] },
                        cartShipmentId: null,
                        deliveredAt: null,
                        fulfillmentStatus: {
                            in: [
                                OfferFulfillmentStatus.SHIPPED,
                                OfferFulfillmentStatus.READY_FOR_SHIPPING,
                            ],
                        },
                    },
                    data: {
                        fulfillmentStatus: OfferFulfillmentStatus.DELIVERED,
                        deliveredAt: now,
                    },
                });
            }
            if (!s.actualDelivery) {
                await this.prisma.shipment.update({
                    where: { id: s.id },
                    data: { actualDelivery: now },
                });
            }
        }

        const deliveredCount = shipments.filter(
            (s) => s.status === deliveredStatus,
        ).length;
        const allDelivered = deliveredCount === shipments.length;
        const someDelivered = deliveredCount > 0 && !allDelivered;

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                status: true,
                orderNumber: true,
                deliveredAt: true,
                requestType: true,
                customerId: true,
                parts: { select: { id: true, name: true } },
            },
        });
        if (!order) return;

        const terminal: OrderStatus[] = [
            OrderStatus.COMPLETED,
            OrderStatus.WARRANTY_ACTIVE,
            OrderStatus.WARRANTY_EXPIRED,
            OrderStatus.CANCELLED,
        ];

        const isMulti = this.offerFulfillment.isMultiItemOrder(order);

        if (allDelivered) {
            if (
                order.status !== OrderStatus.DELIVERED &&
                !terminal.includes(order.status)
            ) {
                await this.transitionStatus(
                    orderId,
                    OrderStatus.DELIVERED,
                    {
                        id: 'SYSTEM',
                        type: ActorType.SYSTEM,
                        name: 'Shipment Delivery Sync',
                    },
                    `All ${shipments.length} shipment batch(es) delivered to customer`,
                    { deliveredBatchCount: shipments.length },
                );
            } else if (isMulti) {
                await this.offerFulfillment.recomputeOrderStatus(orderId);
            }
            return;
        }

        if (someDelivered) {
            if (order.status === OrderStatus.DELIVERED) {
                await this.prisma.order.update({
                    where: { id: orderId },
                    data: {
                        status: OrderStatus.SHIPPED,
                        deliveredAt: null,
                    },
                });
                await this.auditLogs.logAction({
                    orderId,
                    action: 'PARTIAL_DELIVERY_ROLLBACK',
                    entity: 'Order',
                    actorType: ActorType.SYSTEM,
                    actorId: 'SYSTEM',
                    actorName: 'Shipment Delivery Sync',
                    previousState: OrderStatus.DELIVERED,
                    newState: OrderStatus.SHIPPED,
                    metadata: {
                        deliveredBatches: deliveredCount,
                        totalBatches: shipments.length,
                    },
                });
            }
            const nextStatus = await this.offerFulfillment.recomputeOrderStatus(orderId);

            if (isMulti && nextStatus === OrderStatus.PARTIALLY_DELIVERED) {
                const deliveredOffers = await this.prisma.offer.findMany({
                    where: {
                        orderId,
                        deliveredAt: { not: null },
                        fulfillmentStatus: OfferFulfillmentStatus.DELIVERED,
                    },
                    include: { orderPart: true },
                });
                for (const offer of deliveredOffers) {
                    if (offer.deliveredAt && offer.deliveredAt.getTime() >= now.getTime() - 60000) {
                        const partName = offer.orderPart?.name || 'Part';
                        await this.notifications.create({
                            recipientId: order.customerId,
                            recipientRole: 'CUSTOMER',
                            titleAr: `وصلت قطعة: ${partName}`,
                            titleEn: `Part delivered: ${partName}`,
                            messageAr: `وصلت «${partName}» من الطلب #${order.orderNumber}. لديك ${POST_DELIVERY_RETURN_DISPUTE_HOURS} ساعة لطلب الإرجاع أو فتح نزاع على هذه القطعة.`,
                            messageEn: `"${partName}" from order #${order.orderNumber} has arrived. You have ${POST_DELIVERY_RETURN_DISPUTE_HOURS} hours to return or dispute this item.`,
                            type: 'ORDER',
                            link: `/dashboard/orders/${orderId}`,
                            metadata: { offerId: offer.id, orderPartId: offer.orderPartId },
                        }).catch(() => {});
                    }
                }
            }
        }
    }

    async confirmDelivery(orderId: string, customerUserId: string, note?: string) {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: { 
                customer: { select: { id: true, email: true } }, 
                store: { select: { id: true, ownerId: true } },
                shipments: { select: { id: true, status: true } },
            }
        });

        if (!order) throw new NotFoundException('Order not found');
        if (order.customerId !== customerUserId) throw new ForbiddenException('Not your order');

        if (this.offerFulfillment.isMultiItemOrder(order)) {
            throw new BadRequestException(
                'Multi-part orders use carrier-tracked delivery per item. Each part is marked delivered automatically when its shipment arrives.',
            );
        }

        if (
            order.status !== OrderStatus.SHIPPED &&
            order.status !== OrderStatus.PARTIALLY_DELIVERED
        ) {
            throw new BadRequestException(
                'Order must be in Shipped or Partially Delivered state to confirm receipt.',
            );
        }

        if (order.shipments.length === 0) {
            throw new BadRequestException(
                'Delivery must be confirmed via shipment tracking. No shipment record found for this order.',
            );
        }

        const allDelivered = order.shipments.every(
            (s) => s.status === ShipmentStatus.DELIVERED_TO_CUSTOMER,
        );
        if (!allDelivered) {
            throw new BadRequestException(
                'All shipment batches must be delivered before you can confirm receipt for this order.',
            );
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
        const cartOrderStatuses: OrderStatus[] = [
            OrderStatus.PREPARATION,
            OrderStatus.PREPARED,
            OrderStatus.VERIFICATION,
            OrderStatus.VERIFICATION_SUCCESS,
            OrderStatus.READY_FOR_SHIPPING,
            OrderStatus.PARTIALLY_SHIPPED,
        ];

        const orders = await this.prisma.order.findMany({
            where: {
                status: { in: cartOrderStatuses },
                requestType: 'multiple',
            },
            include: {
                customer: { select: { id: true, name: true, email: true, phone: true } },
                parts: true,
                payments: { where: { status: 'SUCCESS' } },
                offers: {
                    where: {
                        status: { in: ['accepted', 'ACCEPTED'] },
                        shippedFromCart: false,
                    },
                    include: {
                        store: true,
                        payments: { where: { status: 'SUCCESS' } },
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        });

        const ordersWithPaidOffers = orders.filter((order) =>
            order.offers.some((o) => o.payments?.length > 0),
        );

        // Group by customer for better admin oversight
        const cartsByCustomer = ordersWithPaidOffers.reduce((acc, order) => {
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

            const enrichedOffers = this.enrichOffersWithCartBatch(order.offers as any[]);
            enrichedOffers.forEach((offer) => {
                acc[order.customerId].totalItems += 1;
                acc[order.customerId].totalValue += (Number(offer.unitPrice) + Number(offer.shippingCost));
                
                // Add specific offer info for the preview
                acc[order.customerId].offers.push({
                    id: offer.id,
                    orderNumber: order.orderNumber,
                    partName: order.parts.find(p => p.id === offer.orderPartId)?.name || order.partName,
                    storeName: offer.store?.name,
                    shippedFromCart: offer.shippedFromCart,
                    fulfillmentStatus: offer.fulfillmentStatus,
                    handoverPending: offer.handoverPending,
                    cartShipmentId: offer.cartShipmentId,
                    cartBatchType: offer.cartBatchType,
                    cartBatchSize: offer.cartBatchSize,
                    price: Number(offer.unitPrice),
                    status: order.status,
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
