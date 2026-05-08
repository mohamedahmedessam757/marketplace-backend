import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStateMachine } from '../orders/fsm/order-state-machine.service';
import { OrdersService } from '../orders/orders.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStatus, ActorType } from '@prisma/client';

@Injectable()
export class OrderCleanupService {
    private readonly logger = new Logger(OrderCleanupService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly orderStateMachine: OrderStateMachine,
        private readonly ordersService: OrdersService,
        private readonly notificationsService: NotificationsService,
    ) { }

    // Run every 1 minute to check for expired orders for near real-time expirations
    @Cron(CronExpression.EVERY_MINUTE)
    async handleCron() {
        this.logger.debug('Running Order Cleanup Job...');
        await this.handleCollectingOffersReveal();
        await this.expireAwaitingSelection();
        await this.expireAwaitingPayment();
        await this.handlePreparationDelays();
        await this.handleCriticalPreparationFailures();
        await this.handleNonMatchingToCorrection();
        await this.handleCorrectionPeriodExpiry();
    }

    // Run every hour to check DELIVERED items and auto-complete after 3 days
    @Cron(CronExpression.EVERY_HOUR)
    async handleDeliveredReturnsAutoCompletion() {
        this.logger.debug('Running Delivered Orders Auto-Completion Job...');

        // Find orders in DELIVERED status where more than 72 hours have passed since delivery
        const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

        const deliveredOrders = await this.prisma.order.findMany({
            where: {
                status: OrderStatus.DELIVERED,
                updatedAt: { // We use updatedAt assuming the last update was when it was marked DELIVERED, or deliveredAt if available in schema
                    lt: threeDaysAgo,
                },
            },
            select: { id: true, orderNumber: true, customerId: true, storeId: true },
        });

        for (const order of deliveredOrders) {
            try {
                // Re-verify status to avoid race conditions or duplicates
                const currentOrder = await this.prisma.order.findUnique({
                    where: { id: order.id },
                    select: { status: true }
                });

                if (!currentOrder || currentOrder.status !== OrderStatus.DELIVERED) {
                    this.logger.debug(`Skipping order ${order.orderNumber} as it is no longer in DELIVERED status.`);
                    continue;
                }

                this.logger.log(`Auto-completing delivered order ${order.orderNumber} (ID: ${order.id}) after 3-day return window`);

                await this.ordersService.transitionStatus(
                    order.id,
                    OrderStatus.COMPLETED,
                    { type: ActorType.SYSTEM, id: 'system-scheduler', name: 'System Scheduler' },
                    'System: Auto-completed after 3-day return window expired'
                );

                // Notify Customer
                await this.notificationsService.create({
                    recipientId: order.customerId,
                    recipientRole: 'CUSTOMER',
                    titleAr: 'انتهاء فترة الاسترجاع للطلب',
                    titleEn: 'Return period expired for order',
                    messageAr: `تم اكتمال الطلب رقم #${order.orderNumber} بنجاح نظراً لمرور مهلة الاسترجاع (3 أيام).`,
                    messageEn: `Order #${order.orderNumber} has been successfully completed since the return window (3 days) expired.`,
                    type: 'system_alert',
                    link: `/dashboard/orders`
                });

                // Notify Vendor (if applicable)
                if (order.storeId) {
                    await this.notificationsService.notifyMerchantByStoreId(order.storeId, {
                        titleAr: 'انتهاء مهلة الاسترجاع',
                        titleEn: 'Return window expired',
                        messageAr: `تم اكتمال الطلب #${order.orderNumber} وانتهت فترة الاسترجاع المسموحة له.`,
                        messageEn: `Order #${order.orderNumber} is now completed and the return period has expired.`,
                        type: 'system_alert',
                        link: `/merchant/orders`
                    });
                }
            } catch (err) {
                this.logger.error(`Failed to auto-complete delivered order ${order.id}:`, err);
            }
        }
    }

    // Run every hour to check PREPARATION (assembly cart) items for 7-day limits and reminders
    @Cron(CronExpression.EVERY_HOUR)
    async handleAssemblyCartCron() {
        this.logger.debug('Running Assembly Cart Auto-Ship & Notifications Job...');
        const now = new Date();
        const orders = await this.prisma.order.findMany({
            where: { status: OrderStatus.PREPARATION },
            include: { 
                payments: true,
                offers: {
                    where: { status: 'accepted' }
                }
            }
        });

        for (const order of orders) {
            try {
                // Determine when the earliest element was paid
                const firstPayment = order.payments.sort((a, b) =>
                    (a.paidAt?.getTime() || 0) - (b.paidAt?.getTime() || 0)
                )[0];
                const paidAt = firstPayment?.paidAt || order.updatedAt;
                const diffHours = (now.getTime() - paidAt.getTime()) / (1000 * 60 * 60);

                // 1. Check 7 Days passed -> AUTO-SHIP (Consolidation) or AUTO-CANCEL (Single Merchant Inaction)
                if (diffHours >= 7 * 24) {
                    if (order.requestType === 'multiple') {
                        this.logger.log(`Auto-shipping assembly cart for order ${order.orderNumber} due to 7-day timeout`);
                        
                        const pendingOfferIds = order.offers
                            .filter(o => !o.shippedFromCart)
                            .map(o => o.id);

                        if (pendingOfferIds.length > 0) {
                            // Force shipment of remaining items
                            await this.ordersService.requestShipping(order.customerId, [], pendingOfferIds);
                            
                            // Notify Customer
                            await this.notificationsService.create({
                                recipientId: order.customerId, recipientRole: 'CUSTOMER',
                                titleAr: 'شحن تلقائي لسلة التجميع 📦', titleEn: 'Auto-Ship: Assembly Cart 📦',
                                messageAr: `لقد مضى 7 أيام على تجميع طلبك رقم #${order.orderNumber}. تم شحن القطع المتاحة حالياً إليك تلقائياً لضمان وصولها في الوقت المحدد.`,
                                messageEn: `7 days have passed for your assembly cart #${order.orderNumber}. Available items have been auto-shipped to ensure timely delivery.`,
                                type: 'system_alert', link: `/dashboard/orders`
                            });
                        }
                    } else {
                        // Single order auto-cancel (standard behavior)
                        this.logger.error(`Auto-cancelling single order ${order.orderNumber} due to merchant inaction (7 days)`);
                        await this.ordersService.transitionStatus(
                            order.id, OrderStatus.CANCELLED,
                            { type: ActorType.SYSTEM, id: 'system-scheduler', name: 'System Scheduler' },
                            'System: Auto-cancelled after 7 days without preparation'
                        );

                        await this.notificationsService.create({
                            recipientId: order.customerId, recipientRole: 'CUSTOMER',
                            titleAr: 'تم إلغاء طلبك لعدم استجابة التاجر', titleEn: 'Order Cancelled: Merchant Inaction',
                            messageAr: `نعتذر منك، تم إلغاء الطلب #${order.orderNumber} تلقائياً لعدم قيام التاجر بتجهيزه خلال مهلة 7 أيام. سيتم البدء بإجراءات استرداد المبلغ.`,
                            messageEn: `We apologize. Order #${order.orderNumber} was auto-cancelled as the merchant failed to prepare it within 7 days. Refund process initiated.`,
                            type: 'system_alert', link: `/dashboard/orders`
                        });

                        for (const offer of order.offers) {
                            if (offer.storeId) {
                                await this.notificationsService.notifyMerchantByStoreId(offer.storeId, {
                                    titleAr: 'مخالفة: إلغاء طلب لتأخر التجهيز', titleEn: 'Violation: Cancelled for Delay',
                                    messageAr: `تم إلغاء الطلب #${order.orderNumber} وتسجيل مخالفة تأخير لعدم التزامكم بالمهلة القصوى (7 أيام).`,
                                    messageEn: `Order #${order.orderNumber} was cancelled and a violation recorded due to failure to prepare within the 7-day limit.`,
                                    type: 'system_alert', link: `/merchant/orders`
                                });
                            }
                        }
                    }
                }
                // 2. Check 48 Hours passed -> URGENT MERCHANT WARNING
                else if (diffHours >= 48 && diffHours < 49) {
                    this.logger.warn(`Sending 48h urgent warning for order ${order.orderNumber}`);
                    for (const offer of order.offers) {
                        if (offer.storeId) {
                            await this.notificationsService.notifyMerchantByStoreId(offer.storeId, {
                                titleAr: '⚠️ إشعار عاجل: تبقت 5 أيام على الإلغاء', titleEn: '⚠️ Urgent: 5 Days Until Cancellation',
                                messageAr: `مرت 48 ساعة على دفع الطلب #${order.orderNumber}. يرجى البدء بالتجهيز والتوثيق فوراً لتجنب الإلغاء التلقائي والمخالفات.`,
                                messageEn: `48 hours have passed since payment for Order #${order.orderNumber}. Please start preparation and verification immediately to avoid auto-cancellation and penalties.`,
                                type: 'system_alert', link: `/merchant/orders/${order.id}`
                            });
                        }
                    }
                }
                // 3. 6 Day reminder for customer
                else if (diffHours >= 6 * 24 && diffHours < (6 * 24) + 1) {
                    await this.notificationsService.create({
                        recipientId: order.customerId, recipientRole: 'CUSTOMER',
                        titleAr: 'تذكير: اقتراب الشحن التلقائي', titleEn: 'Reminder: Auto-Ship Approaching',
                        messageAr: `عناصرك المحتجزة للطلب #${order.orderNumber} أوشكت على إنهاء مدة الحفظ (7 أيام). يرجى تأكيد استلام الشحنة إذا لم تكن ستنتظر قطعاً أخرى.`,
                        messageEn: `Your reserved items for order #${order.orderNumber} are nearing the 7-day limit. Please request shipping soon.`,
                        type: 'system_alert', link: `/dashboard/shipping-cart`
                    });
                }
            } catch (err) {
                this.logger.error(`Error processing assembly cart auto-ship for order ${order.id}:`, err);
            }
        }
    }

    private async handleCollectingOffersReveal() {
        const now = new Date();
        
        // Find orders in COLLECTING_OFFERS where the reveal time has arrived
        const readyToReveal = await this.prisma.order.findMany({
            where: {
                status: OrderStatus.COLLECTING_OFFERS,
                revealOffersAt: {
                    lte: now,
                },
            },
            include: {
                _count: { select: { offers: true } }
            }
        });

        for (const order of readyToReveal) {
            try {
                this.logger.log(`Revealing offers for order ${order.orderNumber} (ID: ${order.id}). Transitioning to AWAITING_SELECTION.`);
                
                await this.ordersService.transitionStatus(
                    order.id,
                    OrderStatus.AWAITING_SELECTION,
                    { type: ActorType.SYSTEM, id: 'system-scheduler', name: 'System Scheduler' },
                    'System: Reveal time reached. Transitioning to Selection phase.'
                );

                // [2026] Centralized Detail: Inform Customer about the Reveal
                if (order._count.offers > 0) {
                    await this.notificationsService.create({
                        recipientId: order.customerId,
                        recipientRole: 'CUSTOMER',
                        titleAr: 'حان وقت اختيار العروض! 🛒',
                        titleEn: 'Time to Select Offers! 🛒',
                        messageAr: `تم انتهاء فترة جمع العروض لطلبك رقم #${order.orderNumber}. يمكنك الآن مراجعة ${order._count.offers} عرض واختيار الأنسب لك.`,
                        messageEn: `The collection period for your order #${order.orderNumber} has ended. You can now review ${order._count.offers} offers and select the best one.`,
                        type: 'OFFER',
                        link: `/dashboard/orders/${order.id}`
                    });
                } else {
                    await this.notificationsService.create({
                        recipientId: order.customerId,
                        recipientRole: 'CUSTOMER',
                        titleAr: 'انتهت مهلة جمع العروض',
                        titleEn: 'Collection Period Ended',
                        messageAr: `نعتذر منك، لم يتم استلام أي عروض للطلب رقم #${order.orderNumber} خلال الـ 24 ساعة الماضية.`,
                        messageEn: `We apologize, no offers were received for order #${order.orderNumber} during the last 24 hours.`,
                        type: 'system_alert',
                        link: `/dashboard/orders/${order.id}`
                    });
                }
            } catch (error) {
                this.logger.error(`Failed to reveal offers for order ${order.id}: ${error.message}`);
            }
        }
    }

    private async expireAwaitingSelection() {
        const now = new Date();

        // Find orders in AWAITING_SELECTION where the customer selection deadline has passed
        const expiredOrders = await this.prisma.order.findMany({
            where: {
                status: OrderStatus.AWAITING_SELECTION,
                selectionDeadlineAt: {
                    lt: now,
                },
            },
            include: {
                _count: {
                    select: { offers: true }
                }
            }
        });

        for (const order of expiredOrders) {
            try {
                const hasOffers = order._count.offers > 0;
                this.logger.log(`Expiring order selection period ${order.orderNumber} (ID: ${order.id}) [hasOffers: ${hasOffers}]`);
                
                await this.ordersService.transitionStatus(
                    order.id,
                    OrderStatus.CANCELLED,
                    { type: ActorType.SYSTEM, id: 'system-scheduler', name: 'System Scheduler' },
                    'System: Selection period expired (48h total elapsed). Customer failed to choose an offer.',
                );

                // Notification
                await this.notificationsService.create({
                    recipientId: order.customerId,
                    recipientRole: 'CUSTOMER',
                    titleAr: 'انتهت مهلة اختيار العرض',
                    titleEn: 'Selection Period Expired',
                    messageAr: `انتهت المهلة المتاحة لاختيار عرض للطلب رقم (#${order.orderNumber}). تم إغلاق الطلب تلقائياً.`,
                    messageEn: `The deadline to select an offer for order (#${order.orderNumber}) has expired. The order has been closed automatically.`,
                    type: 'system_alert'
                });
            } catch (error) {
                this.logger.error(`Failed to expire order selection ${order.id}: ${error.message}`);
            }
        }
    }

    async expireAwaitingPayment() {
        const now = new Date();
        const legacyExpiryDate = new Date();
        legacyExpiryDate.setHours(legacyExpiryDate.getHours() - 24);

        const expiredOrders = await this.prisma.order.findMany({
            where: {
                status: OrderStatus.AWAITING_PAYMENT,
                OR: [
                    {
                        paymentDeadlineAt: {
                            lt: now, // Deadline has passed
                        }
                    },
                    {
                        paymentDeadlineAt: null,
                        updatedAt: {
                            lt: legacyExpiryDate // Fallback for older orders without paymentDeadlineAt
                        }
                    }
                ]
            },
            select: { 
                id: true, 
                orderNumber: true, 
                customerId: true,
                offers: {
                    where: { status: 'accepted' },
                    select: { storeId: true }
                }
            },
        });

        for (const order of expiredOrders) {
            try {
                this.logger.log(`Expiring unpaid order ${order.orderNumber} (ID: ${order.id})`);
                await this.ordersService.transitionStatus(
                    order.id,
                    OrderStatus.CANCELLED,
                    { type: ActorType.SYSTEM, id: 'system-scheduler', name: 'System Scheduler' },
                    'System: Payment period expired after 24 hours',
                );

                // Notify Customer
                await this.notificationsService.create({
                    recipientId: order.customerId,
                    recipientRole: 'CUSTOMER',
                    titleAr: 'انتهاء مهلة الدفع للطلب',
                    titleEn: 'Payment Period Expired',
                    messageAr: `تم إلغاء طلبك (#${order.orderNumber}) لعدم إتمام خطوة السداد خلال الـ 24 ساعة المحددة.`,
                    messageEn: `Your order (#${order.orderNumber}) was cancelled as payment was not completed within the 24h limit.`,
                    type: 'system_alert',
                    link: `/dashboard/orders`
                });

                // Notify Merchants
                for (const offer of order.offers) {
                    if (offer.storeId) {
                        await this.notificationsService.notifyMerchantByStoreId(offer.storeId, {
                            titleAr: 'إلغاء الطلب المعتمد: لم يكتمل الدفع',
                            titleEn: 'Order Cancelled: Unpaid',
                            messageAr: `تم إلغاء الطلب (#${order.orderNumber}) من قبل النظام لتجاوز العميل مهلة السداد (24 ساعة).`,
                            messageEn: `Order (#${order.orderNumber}) was cancelled by the system as the customer missed the 24h payment deadline.`,
                            type: 'system_alert',
                            link: `/merchant/orders`
                        });
                    }
                }
            } catch (error) {
                this.logger.error(`Failed to expire order ${order.id}: ${error.message}`);
            }
        }
    }

    async handlePreparationDelays() {
        const orders = await this.prisma.order.findMany({
            where: { status: OrderStatus.PREPARATION },
            include: {
                payments: {
                    where: { status: 'COMPLETED' },
                    orderBy: { createdAt: 'asc' },
                    take: 1
                },
                offers: {
                    where: { status: 'accepted' },
                    select: { storeId: true }
                }
            }
        });

        const now = Date.now();

        for (const order of orders) {
            try {
                // Determine 48h deadline
                let prepStartTime = order.updatedAt.getTime();
                if (order.payments.length > 0) {
                    prepStartTime = order.payments[0].createdAt.getTime();
                }

                const deadline = prepStartTime + (48 * 60 * 60 * 1000);

                if (now > deadline) {
                    this.logger.warn(`Order ${order.orderNumber} exceeded 48h prep time. Shifting to DELAYED_PREPARATION.`);
                    
                    const delayedDeadline = new Date(now + 24 * 60 * 60 * 1000);

                    await this.ordersService.transitionStatus(
                        order.id,
                        OrderStatus.DELAYED_PREPARATION,
                        { type: ActorType.SYSTEM, id: 'system-scheduler', name: 'System SLA' },
                        'Merchant exceeded 48-hour preparation SLA timeframe'
                    );

                    await this.prisma.order.update({
                        where: { id: order.id },
                        data: {
                            delayedPreparationDeadlineAt: delayedDeadline
                        }
                    });

                    // Notifications to Merchants
                    for (const offer of order.offers) {
                        if (offer.storeId) {
                            await this.notificationsService.notifyMerchantByStoreId(offer.storeId, {
                                titleAr: 'تحذير عاجل: لقد تأخرت في التجهيز',
                                titleEn: 'Urgent: Delayed Preparation SLA',
                                messageAr: `تجاوز الطلب #${order.orderNumber} مهلة 48 ساعة للتجهيز. أمامك 24 ساعة فقط لتسليمه لشركة الشحن لتجنب تسجيل مخالفة للنظام وإلغاء الطلب!`,
                                messageEn: `Order #${order.orderNumber} exceeded the 48h limit. You have exactly 24h to prepare it to avoid SLA violations and cancellation!`,
                                type: 'system_alert',
                                link: `/merchant/orders`
                            });
                        }
                    }

                    // Notification to Admins
                    const admins = await this.prisma.user.findMany({ where: { role: 'ADMIN' } });
                    for (const admin of admins) {
                        await this.notificationsService.create({
                            recipientId: admin.id,
                            recipientRole: 'ADMIN',
                            titleAr: 'تأخير تاجر عن تجهيز طلب',
                            titleEn: 'Store Preparation Delayed',
                            messageAr: `الطلب המعتمد رقم #${order.orderNumber} متأخر في التجهيز لمرور 48 ساعة كاملة. وتم منح التاجر إشعار مهلة حمراء لـ 24 ساعة للإجراء المخالفة التلقائية.`,
                            messageEn: `Order #${order.orderNumber} exceeded the 48h preparation barrier. Merchant was granted a 24h red grace period before auto penalty.`,
                            type: 'system_alert',
                            link: `/admin/orders`
                        });
                    }
                }
            } catch (err) {
                this.logger.error(`Failed executing handlePreparationDelays on ${order.id}: ${err.message}`);
            }
        }
    }

    async handleCriticalPreparationFailures() {
        const now = new Date();

        const criticalOrders = await this.prisma.order.findMany({
            where: {
                status: OrderStatus.DELAYED_PREPARATION,
                delayedPreparationDeadlineAt: { lt: now }
            },
            include: {
                offers: {
                    where: { status: 'accepted' },
                    select: { storeId: true }
                }
            }
        });

        for (const order of criticalOrders) {
            try {
                this.logger.error(`Order ${order.orderNumber} exceeded 24h grace period. Issuing violation and cancellation.`);

                await this.ordersService.transitionStatus(
                    order.id,
                    OrderStatus.CANCELLED,
                    { type: ActorType.SYSTEM, id: 'system-scheduler', name: 'System SLA' },
                    'System: Exceeded 24h extra grace period for preparation. Order abandoned by merchant.',
                );

                for (const offer of order.offers) {
                    if (offer.storeId) {
                        await this.notificationsService.notifyMerchantByStoreId(offer.storeId, {
                            titleAr: 'مخالفة نظام: تم إلغاء الطلب لتأخر التجهيز',
                            titleEn: 'System Violation: Cancelled for Delay',
                            messageAr: `تم مصادرة وإلغاء الطلب #${order.orderNumber} وتسجيل الاستهتار بالوقت في ملف المخالفات الخاص بالمتجر نظراً لعدم التزامكم بتجهيزه بعد إنتهاء الـ 48 ساعة الأولى والمهلة الثانية الإضافية 24 ساعة.`,
                            messageEn: `Order #${order.orderNumber} was cancelled and an SLA violation recorded due to complete failure to prepare within 48h and the 24h grace extension.`,
                            type: 'system_alert',
                            link: `/merchant/orders`
                        });
                    }
                }

                const admins = await this.prisma.user.findMany({ where: { role: 'ADMIN' } });
                for (const admin of admins) {
                    await this.notificationsService.create({
                        recipientId: admin.id,
                        recipientRole: 'ADMIN',
                        titleAr: 'تطبيق مخالفة على متجر وتوقف طلب',
                        titleEn: 'Violation Applied to Store & Order Stopped',
                        messageAr: `تم إلغاء الطلب #${order.orderNumber} لعدم استجابة التاجر خلال مرحلة "التجهيز المتأخر". يجب التحقق واتخاذ اجراءات الخصم وارجاع المبلغ للعميل.`,
                        messageEn: `Order #${order.orderNumber} auto-cancelled. Store failed entirely. Process refund routing and apply penalty.`,
                        type: 'system_alert',
                        link: `/admin/orders`
                    });
                }

                await this.notificationsService.create({
                    recipientId: order.customerId,
                    recipientRole: 'CUSTOMER',
                    titleAr: 'نأسف حقاً: إلغاء طلبك لعدم استجابة التاجر',
                    titleEn: 'Apology: Order Cancelled & Merchant Penalized',
                    messageAr: `نعتذر لك بشدة، قامت الإدارة بشكل تلقائي بإلغاء الطلب #${order.orderNumber} لعدم التزام التاجر بوقت التجهيز، سيتم محاسبة المتجر وبدء ارجاع أموالك الى المحفظة خلال أيام العمل.`,
                    messageEn: `We apologize. Order #${order.orderNumber} was cancelled. The merchant failed to prepare the items. A penalty was issued and your refund has been queued.`,
                    type: 'system_alert',
                    link: `/dashboard/orders`
                });
            } catch (err) {
                this.logger.error(`Failed executing handleCriticalPreparationFailures on ${order.id}: ${err.message}`);
            }
        }
    }

    private async handleNonMatchingToCorrection() {
        const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
        
        const orders = await this.prisma.order.findMany({
            where: {
                status: OrderStatus.NON_MATCHING,
                updatedAt: { lt: twoMinutesAgo }
            }
        });

        for (const order of orders) {
            try {
                this.logger.log(`Transitioning ${order.orderNumber} from NON_MATCHING to CORRECTION_PERIOD`);
                await this.ordersService.transitionStatus(
                    order.id,
                    OrderStatus.CORRECTION_PERIOD,
                    { type: ActorType.SYSTEM, id: 'system-scheduler', name: 'System Scheduler' },
                    'System: 2 minutes passed since NON_MATCHING, entering CORRECTION_PERIOD.'
                );

                // Notifications were already sent during adminReviewVerification, so we might just add an audit.
            } catch (err) {
                this.logger.error(`Failed to start correction period for ${order.id}:`, err);
            }
        }
    }

    private async handleCorrectionPeriodExpiry() {
        const now = new Date();

        const expiredOrders = await this.prisma.order.findMany({
            where: {
                status: OrderStatus.CORRECTION_PERIOD,
                correctionDeadlineAt: { lt: now }
            },
            include: {
                offers: true
            }
        });

        for (const order of expiredOrders) {
            try {
                this.logger.log(`Cancelling order ${order.orderNumber} due to CORRECTION_PERIOD timeout.`);
                
                await this.ordersService.transitionStatus(
                    order.id,
                    OrderStatus.CANCELLED,
                    { type: ActorType.SYSTEM, id: 'system-scheduler', name: 'System Scheduler' },
                    'System: Merchant failed to provide corrected verification within 48h limit.'
                );

                // Notify Merchant
                if (order.storeId) {
                    await this.notificationsService.notifyMerchantByStoreId(order.storeId, {
                        titleAr: 'إلغاء الطلب: انتهاء مهلة التصحيح', titleEn: 'Order Cancelled: Correction Timeout',
                        messageAr: `تم إلغاء الطلب #${order.orderNumber} لعدم رفعك التوثيق المصحح خلال 48 ساعة. سيتم إرجاع المبلغ للعميل وتطبيق مخالفة.`,
                        messageEn: `Order #${order.orderNumber} cancelled because corrected verification was not provided within 48h.`,
                        type: 'system_alert', link: `/merchant/orders`
                    });
                }
                
                // Notify Customer
                await this.notificationsService.create({
                    recipientId: order.customerId, recipientRole: 'CUSTOMER',
                    titleAr: 'إلغاء الطلب واسترجاع المبلغ', titleEn: 'Order Cancelled & Refunded',
                    messageAr: `تم إلغاء طلبك #${order.orderNumber} لعدم تمكن البائع من تقديم القطعة المطابقة للمواصفات. جاري استرجاع أموالك.`,
                    messageEn: `Order #${order.orderNumber} cancelled as the seller failed to provide a matching part. Refund initiated.`,
                    type: 'system_alert', link: `/dashboard/orders`
                });

                // Admin Notification
                const admins = await this.prisma.user.findMany({ where: { role: 'ADMIN' } });
                for (const admin of admins) {
                    await this.notificationsService.create({
                        recipientId: admin.id, recipientRole: 'ADMIN',
                        titleAr: 'تطبيق مخالفة على متجر وتوقف طلب', titleEn: 'Store Violation & Order Cancelled',
                        messageAr: `تم إلغاء الطلب #${order.orderNumber} لانتهاء مهلة التصحيح (48 ساعة). يرجى معالجة الاسترجاع للعميل وتطبيق المخالفة على المتجر.`,
                        messageEn: `Order #${order.orderNumber} cancelled due to correction timeout. Please process refund and store penalty.`,
                        type: 'system_alert', link: `/admin/orders`
                    });
                }
            } catch (err) {
                this.logger.error(`Failed processing correction timeout for ${order.id}:`, err);
            }
        }
    }
}
