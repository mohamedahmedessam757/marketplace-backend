import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateShipmentDto } from './dto/create-shipment.dto';
import { UpdateShipmentStatusDto } from './dto/update-shipment-status.dto';
import { ShipmentStatus, ActorType } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { UsersService } from '../users/users.service';

// Premium Bilingual status labels for notifications (Enthusiastic & Clear)
const STATUS_LABELS: Record<string, { ar: string; en: string }> = {
    RECEIVED_AT_HUB:           { ar: 'تم استلام الشحنة في المركز 📥 جاري البدء في إجراءات الفحص والتوثيق.', en: 'Shipment received at the hub 📥 Quality check and verification started.' },
    QUALITY_CHECK_PASSED:      { ar: 'اجتازت الفحص بنجاح! ✅ القطعة مطابقة للمواصفات وجاهزة للتغليف.', en: 'Quality check passed! ✅ The part matches specifications and is ready for packaging.' },
    PACKAGED_FOR_SHIPPING:     { ar: 'تم التغليف بأمان 📦 شحنتك الآن جاهزة للانطلاق نحو وجهتها.', en: 'Packaged securely 📦 Your shipment is now ready to head to its destination.' },
    AWAITING_CARRIER_PICKUP:   { ar: 'بانتظار المندوب ⏳ تم تجهيز الشحنة وهي الآن تنتظر الاستلام من شركة الشحن.', en: 'Awaiting carrier pickup ⏳ Shipment is ready and waiting for the courier.' },
    PICKED_UP_BY_CARRIER:      { ar: 'انطلقت الشحنة! 🚀 استلمت شركة الشحن طردك وهي في طريقها إليك.', en: 'Shipment has launched! 🚀 The courier picked up your package and is on the way.' },
    IN_TRANSIT_TO_DESTINATION: { ar: 'شحنتك بين أيدٍ أمينة 🛣️ وهي الآن تتحرك نحو وجهتها النهائية.', en: 'Your shipment is in safe hands 🛣️ and is moving towards its destination.' },
    ARRIVED_AT_LOCAL_FACILITY: { ar: 'وصلت الشحنة إلى مركز التوزيع المحلي 📍 أصبحت قريبة جداً منك.', en: 'Shipment reached the local distribution hub 📍 It is very close now.' },
    CUSTOMS_CLEARANCE:         { ar: 'إجراءات روتينية 🛠️ الشحنة حالياً في مرحلة التخليص الجمركي.', en: 'Routine procedures 🛠️ Shipment is currently in customs clearance.' },
    AT_LOCAL_WAREHOUSE:        { ar: 'وصلت إلى مدينتك! 🌆 الشحنة الآن في مستودع الشحن المحلي بانتظار خروج المندوب.', en: 'Reached your city! 🌆 Shipment is at the local warehouse awaiting delivery.' },
    OUT_FOR_DELIVERY:          { ar: 'استعد للاستلام! 🛵 المندوب في الطريق إليك اليوم، يرجى التواجد.', en: 'Get ready! 🛵 The courier is on the way to you today, please be available.' },
    DELIVERY_ATTEMPTED:        { ar: 'حاولنا الوصول إليك 🔔 ولكن لم نتمكن من التسليم. سنعيد المحاولة قريباً.', en: 'We tried to reach you 🔔 but could not deliver. We will retry soon.' },
    DELIVERED_TO_CUSTOMER:     { ar: 'تم التسليم بنجاح! ✅ نأمل أن تكون تجربتك معنا رائعة، يومك سعيد.', en: 'Delivered successfully! ✅ We hope you had a great experience with us.' },
    
    // New Return & Warranty Journey 2026
    RETURN_LABEL_ISSUED:       { ar: 'يتم أصدار بوليصة أرجاع للمنتج 📄', en: 'Return label has been successfully issued for the product 📄' },
    RETURN_STARTED:            { ar: 'بدء الارجاع 🔄 ننتظر تسليم الشحنة للمندوب.', en: 'Return process started 🔄 awaiting shipment handover to courier.' },
    RECEIVED_FROM_CUSTOMER:    { ar: 'تم أستلام الشحنه من العميل بنجاح 📥 وهي الآن في طريقها للفرز.', en: 'Shipment successfully received from customer 📥 and is now being sorted.' },
    DELIVERED_TO_VENDOR:       { ar: 'تم تسليم الشحنه للتاجر 📦 للمراجعة أو الاستبدال.', en: 'Shipment delivered to vendor 📦 for review or exchange.' },
    EXCHANGE_COMPLETED:        { ar: 'تم أستبدال الشحنه بنجاح ✨ جاري التجهيز لإرسالها إليك.', en: 'Shipment exchange completed successfully ✨ preparing to send it back to you.' },
    IN_TRANSIT_TO_CUSTOMER:    { ar: 'الشحنه فى طريقها للعميل 🚚 انتظرنا قريباً.', en: 'Shipment is on its way back to the customer 🚚 see you soon.' },
    RETURN_COMPLETED_TO_CUSTOMER: { ar: 'تم أرجاع الشحنه للعميل بنجاح ✅ تم إغلاق الطلب.', en: 'Shipment successfully returned to customer ✅ Order completed.' },
    
    // Legacy/Internal states
    RETURN_TO_SENDER_INITIATED:{ ar: 'بدء إجراءات الإرجاع 🔄 لضمان وصول الشحنة للمرسل بأمان.', en: 'Return to sender initiated 🔄 to ensure safe arrival.' },
    RETURNED_TO_SENDER:        { ar: 'تم إرجاع الطرد للمرسل بنجاح.', en: 'Returned to sender successfully.' },
    CUSTOMS_DELAY:             { ar: 'نعتذر عن التأخير، الشحنة حالياً لدى الجمارك في دولتك .', en: 'We apologize for the delay, the shipment is currently at customs in your country.' },
    RETURN_WAYBILL_ISSUED:     { ar: 'تم إصدار بوليصة الإرجاع 📄 يرجى تسليم القطعة لشركة الشحن.', en: 'Return waybill issued 📄 Please hand over the part to the courier.' },
    RETURN_RECEIVED:           { ar: 'تم استلام المرتجع في مركزنا 📥 جاري فحصه ومعالجة طلبك.', en: 'Return received at our hub 📥 Checking and processing your request.' },
    EXCHANGE_SHIPPED:          { ar: 'تم شحن القطعة البديلة 📤 هي الآن في طريقها إليك.', en: 'Exchange part shipped 📤 It is now on its way to you.' },
    RETURN_TO_CUSTOMER:        { ar: 'جاري إعادة القطعة إليك 🚚 بعد مراجعة طلب الإرجاع.', en: 'Part is being returned to you 🚚 after reviewing the return request.' },
};

/** Operational copy for merchants (their sold order — not “your shipment to you”). */
const MERCHANT_STATUS_LABELS: Record<string, { ar: string; en: string }> = {
    RECEIVED_AT_HUB:           { ar: 'استُلمت شحنة الطلب في مركز المنصة وجاري الفحص.', en: 'Order shipment received at hub; inspection in progress.' },
    QUALITY_CHECK_PASSED:      { ar: 'اجتازت شحنة الطلب فحص الجودة.', en: 'Order shipment passed quality check.' },
    PACKAGED_FOR_SHIPPING:     { ar: 'تم تغليف شحنة الطلب وهي جاهزة للإرسال.', en: 'Order shipment packaged and ready to ship.' },
    AWAITING_CARRIER_PICKUP:   { ar: 'شحنة الطلب بانتظار استلام المندوب/شركة الشحن.', en: 'Order shipment awaiting carrier pickup.' },
    PICKED_UP_BY_CARRIER:      { ar: 'استلمت شركة الشحن شحنة الطلب — في الطريق للعميل.', en: 'Carrier picked up the order shipment — en route to customer.' },
    IN_TRANSIT_TO_DESTINATION: { ar: 'شحنة الطلب في الطريق إلى وجهة العميل.', en: 'Order shipment in transit to customer.' },
    ARRIVED_AT_LOCAL_FACILITY: { ar: 'شحنة الطلب وصلت مركز التوزيع المحلي.', en: 'Order shipment arrived at local facility.' },
    CUSTOMS_CLEARANCE:         { ar: 'شحنة الطلب في التخليص الجمركي.', en: 'Order shipment in customs clearance.' },
    AT_LOCAL_WAREHOUSE:        { ar: 'شحنة الطلب في مستودع الشحن المحلي.', en: 'Order shipment at local warehouse.' },
    OUT_FOR_DELIVERY:          { ar: 'شحنة الطلب خرجت للتسليم للعميل.', en: 'Order shipment out for delivery to customer.' },
    DELIVERY_ATTEMPTED:        { ar: 'محاولة تسليم للعميل لم تنجح — قد تُعاد المحاولة.', en: 'Delivery attempt to customer failed — may retry.' },
    DELIVERED_TO_CUSTOMER:     { ar: 'تم تسليم الطلب للعميل بنجاح.', en: 'Order delivered to customer successfully.' },
    RETURN_LABEL_ISSUED:       { ar: 'صدرت بوليصة إرجاع لطلبك.', en: 'Return label issued for your order.' },
    RETURN_STARTED:            { ar: 'بدأ مسار إرجاع شحنة الطلب.', en: 'Return journey started for order shipment.' },
    RECEIVED_FROM_CUSTOMER:    { ar: 'استُلم المرتجع من العميل في المركز.', en: 'Return received from customer at hub.' },
    DELIVERED_TO_VENDOR:       { ar: 'وصل المرتجع إلى متجرك للمراجعة.', en: 'Return delivered to your store for review.' },
    EXCHANGE_COMPLETED:        { ar: 'اكتمل استبدال القطعة — جاري إرسال البديل للعميل.', en: 'Exchange completed — replacement shipping to customer.' },
    IN_TRANSIT_TO_CUSTOMER:    { ar: 'الشحنة البديلة في الطريق للعميل.', en: 'Replacement shipment in transit to customer.' },
    RETURN_COMPLETED_TO_CUSTOMER: { ar: 'اكتمل إرجاع الشحنة للعميل.', en: 'Return to customer completed.' },
    RETURN_TO_SENDER_INITIATED:{ ar: 'بدأت إجراءات إرجاع الشحنة للمرسل.', en: 'Return-to-sender process started.' },
    RETURNED_TO_SENDER:        { ar: 'أُعيدت الشحنة للمرسل.', en: 'Shipment returned to sender.' },
    CUSTOMS_DELAY:             { ar: 'تأخير جمركي على شحنة الطلب.', en: 'Customs delay on order shipment.' },
    RETURN_WAYBILL_ISSUED:     { ar: 'صدرت بوليصة إرجاع للطلب.', en: 'Return waybill issued for order.' },
    RETURN_RECEIVED:           { ar: 'استُلم المرتجع في المركز.', en: 'Return received at hub.' },
    EXCHANGE_SHIPPED:          { ar: 'شُحن البديل للعميل.', en: 'Exchange part shipped to customer.' },
    RETURN_TO_CUSTOMER:        { ar: 'جاري إرجاع القطعة للعميل.', en: 'Part return to customer in progress.' },
};

/** Short operational copy for platform admins. */
const ADMIN_STATUS_LABELS: Record<string, { ar: string; en: string }> = {
    RECEIVED_AT_HUB:           { ar: 'استلام في المركز.', en: 'Received at hub.' },
    QUALITY_CHECK_PASSED:      { ar: 'اجتاز فحص الجودة.', en: 'Quality check passed.' },
    PACKAGED_FOR_SHIPPING:     { ar: 'تم التغليف.', en: 'Packaged.' },
    AWAITING_CARRIER_PICKUP:   { ar: 'بانتظار المندوب.', en: 'Awaiting carrier.' },
    PICKED_UP_BY_CARRIER:      { ar: 'تسليم لشركة الشحن.', en: 'Handed to carrier.' },
    IN_TRANSIT_TO_DESTINATION: { ar: 'في الطريق.', en: 'In transit.' },
    ARRIVED_AT_LOCAL_FACILITY: { ar: 'وصل المركز المحلي.', en: 'At local facility.' },
    CUSTOMS_CLEARANCE:         { ar: 'تخليص جمركي.', en: 'Customs clearance.' },
    AT_LOCAL_WAREHOUSE:        { ar: 'في المستودع المحلي.', en: 'At local warehouse.' },
    OUT_FOR_DELIVERY:          { ar: 'خارج للتسليم.', en: 'Out for delivery.' },
    DELIVERY_ATTEMPTED:        { ar: 'محاولة تسليم فاشلة.', en: 'Delivery attempt failed.' },
    DELIVERED_TO_CUSTOMER:     { ar: 'تم التسليم للعميل.', en: 'Delivered to customer.' },
    RETURN_LABEL_ISSUED:       { ar: 'بوليصة إرجاع.', en: 'Return label issued.' },
    RETURN_STARTED:            { ar: 'بدء الإرجاع.', en: 'Return started.' },
    RECEIVED_FROM_CUSTOMER:    { ar: 'استلام من العميل.', en: 'Received from customer.' },
    DELIVERED_TO_VENDOR:       { ar: 'تسليم للتاجر.', en: 'Delivered to vendor.' },
    EXCHANGE_COMPLETED:        { ar: 'اكتمل الاستبدال.', en: 'Exchange completed.' },
    IN_TRANSIT_TO_CUSTOMER:    { ar: 'في الطريق للعميل.', en: 'In transit to customer.' },
    RETURN_COMPLETED_TO_CUSTOMER: { ar: 'إرجاع مكتمل للعميل.', en: 'Return completed to customer.' },
    RETURN_TO_SENDER_INITIATED:{ ar: 'إرجاع للمرسل.', en: 'Return to sender.' },
    RETURNED_TO_SENDER:        { ar: 'أُعيد للمرسل.', en: 'Returned to sender.' },
    CUSTOMS_DELAY:             { ar: 'تأخير جمركي.', en: 'Customs delay.' },
    RETURN_WAYBILL_ISSUED:     { ar: 'بوليصة إرجاع.', en: 'Return waybill.' },
    RETURN_RECEIVED:           { ar: 'مرتجع في المركز.', en: 'Return at hub.' },
    EXCHANGE_SHIPPED:          { ar: 'شحن بديل.', en: 'Exchange shipped.' },
    RETURN_TO_CUSTOMER:        { ar: 'إرجاع للعميل.', en: 'Return to customer.' },
};

function buildShipmentNotifyBodies(
    status: ShipmentStatus,
    orderNumber: string,
    note: string | undefined,
    customsSuffixAr: string,
    customsSuffixEn: string,
) {
    const customer = STATUS_LABELS[status];
    const merchant = MERCHANT_STATUS_LABELS[status] ?? {
        ar: `تحديث مرحلة الشحن (${status}).`,
        en: `Shipping stage updated (${status}).`,
    };
    const admin = ADMIN_STATUS_LABELS[status] ?? {
        ar: `حالة الشحنة: ${status}.`,
        en: `Shipment status: ${status}.`,
    };
    const noteAr = note ? `\n${note}` : '';
    const noteEn = note ? `\n${note}` : '';
    return {
        customer: {
            ar: `طلب #${orderNumber}: ${customer.ar}${noteAr}${customsSuffixAr}`,
            en: `Order #${orderNumber}: ${customer.en}${noteEn}${customsSuffixEn}`,
        },
        merchant: {
            ar: `طلب #${orderNumber}: ${merchant.ar}${noteAr}${status === ShipmentStatus.CUSTOMS_DELAY ? customsSuffixAr : ''}`,
            en: `Order #${orderNumber}: ${merchant.en}${noteEn}${status === ShipmentStatus.CUSTOMS_DELAY ? customsSuffixEn : ''}`,
        },
        admin: {
            ar: `طلب #${orderNumber}: ${admin.ar}${noteAr}${status === ShipmentStatus.CUSTOMS_DELAY ? customsSuffixAr : ''}`,
            en: `Order #${orderNumber}: ${admin.en}${noteEn}${status === ShipmentStatus.CUSTOMS_DELAY ? customsSuffixEn : ''}`,
        },
    };
}

@Injectable()
export class ShipmentsService {
    constructor(
        private prisma: PrismaService,
        private notifications: NotificationsService,
        private auditLogs: AuditLogsService,
        private users: UsersService,
        @Inject(forwardRef(() => OrdersService))
        private ordersService: OrdersService,
    ) {}

    private adminShipmentInclude() {
        return {
            order: {
                select: {
                    orderNumber: true,
                    status: true,
                    vehicleMake: true,
                    vehicleModel: true,
                    partName: true,
                    partDescription: true,
                    requestType: true,
                    customer: { select: { id: true, name: true } },
                },
            },
            waybill: {
                select: {
                    waybillNumber: true,
                    finalPrice: true,
                    partName: true,
                    partDescription: true,
                    issueMode: true,
                },
            },
            cartOffers: {
                select: {
                    id: true,
                    offerImage: true,
                    orderPart: { select: { name: true } },
                    store: { select: { name: true, storeCode: true } },
                },
            },
            updater: { select: { id: true, name: true } },
        };
    }

    /** Enriched shipment row for admin list/detail (batch parts, waybill, vehicle). */
    private mapShipmentForAdminList(shipment: any) {
        if (!shipment) return shipment;

        const cartOffers = shipment.cartOffers || [];
        const cartPartNames = cartOffers
            .map((o: any) => o.orderPart?.name)
            .filter(Boolean) as string[];

        const batchItems =
            cartPartNames.length > 0
                ? cartPartNames.map((name: string) => ({ name, quantity: 1 }))
                : [
                      {
                          name:
                              shipment.waybill?.partName ||
                              shipment.order?.partName ||
                              'Part',
                          quantity: 1,
                      },
                  ];

        const batchPartDescription =
            cartPartNames.length > 1
                ? `Assembly batch (${cartPartNames.length} parts): ${cartPartNames.join(' · ')}`
                : cartPartNames[0] ||
                  shipment.waybill?.partDescription ||
                  shipment.order?.partDescription ||
                  null;

        return {
            ...shipment,
            items: batchItems,
            batchPartNames: cartPartNames,
            cartBatchSize: cartPartNames.length || batchItems.length,
            cartBatchType:
                cartPartNames.length > 1
                    ? 'group'
                    : cartPartNames.length === 1
                      ? 'solo'
                      : null,
            partDescription:
                shipment.waybill?.partDescription || batchPartDescription,
            waybillNumber: shipment.waybill?.waybillNumber ?? null,
            issueMode: shipment.waybill?.issueMode ?? null,
            waybillValue: shipment.waybill?.finalPrice
                ? Number(shipment.waybill.finalPrice)
                : null,
            vehicleMake: shipment.order?.vehicleMake ?? null,
            vehicleModel: shipment.order?.vehicleModel ?? null,
        };
    }

    private async reloadShipmentForAdmin(id: string) {
        const row = await this.prisma.shipment.findUnique({
            where: { id },
            include: this.adminShipmentInclude(),
        });
        if (!row) throw new NotFoundException('Shipment not found');
        return this.mapShipmentForAdminList(row);
    }

    async create(data: CreateShipmentDto, userId?: string | null) {
        // Updated for 2026 Partial Shipping: Multiple shipments per order are allowed
        // Idempotency check now includes waybillId to allow separate shipments for the same order
        const existing = await this.prisma.shipment.findFirst({
            where: { 
                orderId: data.orderId,
                waybillId: data.waybillId || null
            }
        });
        if (existing) {
            // Idempotent: return existing shipment if the waybill matches
            return existing;
        }

        const shipment = await this.prisma.shipment.create({
            data: {
                orderId: data.orderId,
                waybillId: data.waybillId,
                carrierType: data.carrierType ?? 'NO_TRACKING',
                carrierName: data.carrierName,
                trackingNumber: data.trackingNumber,
                carrierApiUrl: data.carrierApiUrl,
                updatedBy: userId ?? null,
                // Starts at RECEIVED_AT_HUB - the admin will update the 12-step status
                status: 'RECEIVED_AT_HUB',
            }
        });

        await this.prisma.shipmentStatusLog.create({
            data: {
                shipmentId: shipment.id,
                fromStatus: null,
                toStatus: 'RECEIVED_AT_HUB',
                changedBy: userId ?? null,
                source: userId ? 'MANUAL' : 'SYSTEM',
                notes: userId ? 'Shipment created by merchant request' : 'Shipment created by automated waybill issuance'
            }
        });

        // 2026 Audit Trail: Log to global audit system
        const actor = userId ? await this.users.findById(userId) : null;
        await this.auditLogs.logAction({
            action: 'CREATE',
            entity: 'SHIPMENT',
            actorType: (actor?.role as any) || 'SYSTEM',
            actorId: userId ?? undefined,
            actorName: actor?.name || 'System',
            newState: JSON.stringify({ status: 'RECEIVED_AT_HUB', orderId: data.orderId }),
            reason: 'Shipment initialization at hub',
            metadata: { orderId: data.orderId, trackingNumber: data.trackingNumber }
        });

        return shipment;
    }

    async updateStatus(id: string, userId: string, data: UpdateShipmentStatusDto) {
        const shipment = await this.prisma.shipment.findUnique({
            where: { id },
            include: { order: true }
        });

        if (!shipment) throw new NotFoundException('Shipment not found');

        const oldStatus = shipment.status;
        const newStatus = data.status as ShipmentStatus;

        const isDelivered = newStatus === ShipmentStatus.DELIVERED_TO_CUSTOMER;
        const isPickedUp = newStatus === ShipmentStatus.PICKED_UP_BY_CARRIER;

        const updated = await this.prisma.shipment.update({
            where: { id },
            data: {
                status: newStatus,
                statusNotes: data.notes ?? shipment.statusNotes,
                customsDelayNote: data.customsDelayNote ?? shipment.customsDelayNote,
                carrierName: data.carrierName ?? shipment.carrierName,
                trackingNumber: data.trackingNumber ?? shipment.trackingNumber,
                carrierApiUrl: data.carrierApiUrl ?? shipment.carrierApiUrl,
                carrierType: data.carrierType ?? shipment.carrierType,
                trackingLink: data.trackingLink ?? shipment.trackingLink,
                estimatedDelivery: data.estimatedDelivery ? new Date(data.estimatedDelivery) : shipment.estimatedDelivery,
                updatedBy: userId,
                actualDelivery: isDelivered ? new Date() : shipment.actualDelivery,
            }
        });

        // Log the transition
        await this.prisma.shipmentStatusLog.create({
            data: {
                shipmentId: id,
                fromStatus: oldStatus,
                toStatus: newStatus,
                changedBy: userId,
                notes: data.notes,
                source: 'MANUAL'
            }
        });

        // 2026 Audit Trail: Log status transition to global audit system
        const actor = await this.users.findById(userId);
        await this.auditLogs.logAction({
            action: 'STATUS_CHANGE',
            entity: 'SHIPMENT',
            actorType: (actor?.role as any) || 'SYSTEM',
            actorId: userId,
            actorName: actor?.name || 'System',
            previousState: oldStatus,
            newState: newStatus,
            reason: data.notes || `Shipment moved to ${newStatus}`,
            metadata: { 
                shipmentId: id, 
                orderId: shipment.orderId,
                trackingNumber: shipment.trackingNumber 
            }
        });

        if (isPickedUp && shipment.order) {
            const orderRow = await this.prisma.order.findUnique({
                where: { id: shipment.orderId },
                select: { status: true },
            });
            const terminal = ['DELIVERED', 'COMPLETED', 'WARRANTY_ACTIVE', 'WARRANTY_EXPIRED'];
            if (orderRow && !terminal.includes(orderRow.status)) {
                await this.prisma.order.update({
                    where: { id: shipment.orderId },
                    data: { status: 'SHIPPED' },
                });
            }
        }

        if (isDelivered) {
            await this.ordersService.syncOrderStatusAfterShipmentDelivery(
                shipment.orderId,
            );
        }

        // 2026 Logic: When return to customer is completed -> mark order as COMPLETED
        if ((newStatus as string) === 'RETURN_COMPLETED_TO_CUSTOMER' && shipment.order) {
            await this.prisma.order.update({
                where: { id: shipment.orderId },
                data: { 
                    status: 'COMPLETED',
                    updatedAt: new Date()
                }
            });
        }

        // Send rich bilingual notifications
        await this.notifyRelevantUsers(shipment.orderId, newStatus, data.notes, data.customsDelayNote ?? shipment.customsDelayNote);

        return this.reloadShipmentForAdmin(id);
    }

    async getByOrderId(orderId: string) {
        return this.prisma.shipment.findFirst({
            where: { orderId },
            include: {
                order: {
                    select: {
                        orderNumber: true,
                        status: true,
                        customer: { select: { id: true, name: true, email: true } }
                    }
                },
                statusLogs: { orderBy: { createdAt: 'desc' } }
            }
        });
    }

    async findAll() {
        const rows = await this.prisma.shipment.findMany({
            include: this.adminShipmentInclude(),
            orderBy: { updatedAt: 'desc' },
        });
        return rows.map((s) => this.mapShipmentForAdminList(s));
    }

    /**
     * Fetch shipments for a specific user based on their role.
     * - CUSTOMER: Orders where customer_id matches.
     * - VENDOR: Orders where the store belongs to the user.
     * This bypasses Supabase RLS by going through Prisma directly.
     */
    async findMyShipments(userId: string, role: string) {
        let orderFilter: any = {};

        if (role === 'VENDOR') {
            const store = await this.prisma.store.findUnique({ where: { ownerId: userId } });
            if (!store) return [];
            // For vendors: verify ownership via storeId or acceptedOffer.storeId
            orderFilter = {
                OR: [
                    { storeId: store.id },
                    { acceptedOffer: { storeId: store.id } },
                    { offers: { some: { storeId: store.id, status: { in: ['accepted', 'ACCEPTED'] } } } }
                ],
                AND: [
                    {
                        OR: [
                            { shipments: { some: {} } },
                            { status: { in: ['READY_FOR_SHIPPING', 'SHIPPED', 'DELIVERED', 'RETURNED', 'COMPLETED'] } }
                        ]
                    }
                ]
            };
        } else {
            // CUSTOMER: show any order that has a shipment or is in a shipping status
            orderFilter = {
                customerId: userId,
                OR: [
                    { shipments: { some: {} } },
                    { status: { in: ['READY_FOR_SHIPPING', 'SHIPPED', 'DELIVERED', 'RETURNED', 'COMPLETED'] } }
                ]
            };
        }

        const orders = await this.prisma.order.findMany({
            where: {
                ...orderFilter,
            },
            select: {
                id: true,
                orderNumber: true,
                status: true,
                vehicleMake: true,
                vehicleModel: true,
                partName: true,
                partDescription: true,
                partImages: true, // New: Customer Request Photos
                updatedAt: true,
                customerId: true,
                store: {
                    select: {
                        storeCode: true,
                        address: true
                    }
                },
                acceptedOffer: {
                    select: {
                        weightKg: true,
                        offerImage: true
                    }
                },
                offers: {
                    where: { status: { in: ['accepted', 'ACCEPTED'] } },
                    select: {
                        weightKg: true,
                        offerImage: true,
                        store: {
                            select: { storeCode: true }
                        }
                    },
                    take: 1
                },
                shippingAddresses: {
                    select: {
                        country: true,
                        city: true,
                        details: true
                    },
                    take: 1
                },
                shipments: {
                    select: {
                        id: true,
                        trackingNumber: true,
                        trackingLink: true,
                        carrierName: true,
                        status: true,
                        estimatedDelivery: true,
                        updatedAt: true,
                        cartOffers: {
                            select: {
                                id: true,
                                orderPart: { select: { name: true } },
                                offerImage: true,
                                weightKg: true,
                            },
                        },
                    },
                    orderBy: { updatedAt: 'desc' }
                }
            },
            orderBy: { updatedAt: 'desc' }
        });

        const rows: any[] = [];
        for (const order of orders as any[]) {
            const addr = order.shippingAddresses?.[0] ?? null;
            let defaultOffer = order.acceptedOffer;
            if (!defaultOffer && order.offers?.length > 0) {
                defaultOffer = order.offers[0];
            }

            const shipmentList =
                order.shipments?.length > 0 ? order.shipments : [null];

            for (const s of shipmentList) {
                const cartOffers = s?.cartOffers || [];
                const cartPartNames = cartOffers
                    .map((o: any) => o.orderPart?.name)
                    .filter(Boolean) as string[];
                const batchOffer = cartOffers[0] ?? defaultOffer;
                const batchItems =
                    cartPartNames.length > 0
                        ? cartPartNames.map((name: string) => ({ name, quantity: 1 }))
                        : [
                              {
                                  name: `${order.vehicleMake} ${order.vehicleModel} - ${order.partName}`,
                                  quantity: 1,
                              },
                          ];
                const batchPartDescription =
                    cartPartNames.length > 1
                        ? `Assembly batch (${cartPartNames.length} parts): ${cartPartNames.join(' · ')}`
                        : order.partDescription;

                rows.push({
                    id: s?.id || order.id,
                    orderId: order.id,
                    trackingNumber: s?.trackingNumber || order.orderNumber,
                    trackingLink: s?.trackingLink || null,
                    carrier: s?.carrierName || null,
                    status:
                        s?.status ||
                        (order.status === 'READY_FOR_SHIPPING'
                            ? 'RECEIVED_AT_HUB'
                            : order.status === 'DELIVERED'
                              ? 'DELIVERED_TO_CUSTOMER'
                              : 'IN_TRANSIT_TO_DESTINATION'),
                    estimatedDelivery: s?.estimatedDelivery ?? null,
                    updatedAt: s?.updatedAt || order.updatedAt,
                    orderNumber: order.orderNumber,
                    requestType: order.requestType,
                    shippingType: order.shippingType,
                    vehicleMake: order.vehicleMake,
                    vehicleModel: order.vehicleModel,
                    partName: order.partName,
                    partDescription: batchPartDescription,
                    partImages: order.partImages || [],
                    offerImage: batchOffer?.offerImage || defaultOffer?.offerImage || null,
                    weightKg: batchOffer?.weightKg
                        ? Number(batchOffer.weightKg)
                        : defaultOffer?.weightKg
                          ? Number(defaultOffer.weightKg)
                          : null,
                    cartBatchSize: cartPartNames.length || null,
                    cartBatchType:
                        cartPartNames.length > 1
                            ? 'group'
                            : cartPartNames.length === 1
                              ? 'solo'
                              : null,
                    items: batchItems,
                    storeCode:
                        order.store?.storeCode ||
                        defaultOffer?.store?.storeCode ||
                        'STR-TASHLEH',
                    customerCode: `CUST-${order.customerId.substring(0, 8).toUpperCase()}`,
                    shippingAddress: addr
                        ? `${addr.details}, ${addr.city}, ${addr.country}`
                        : 'Pending Address',
                    customerCountry: addr?.country || 'N/A',
                    customerCity: addr?.city || 'N/A',
                    customerDetails: addr?.details || 'N/A',
                    origin: 'Tashleh Hub',
                    destination: addr
                        ? `${addr.city}, ${addr.country}`
                        : 'Customer Address',
                });
            }
        }

        return rows.sort(
            (a, b) =>
                new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
    }

    async getLogs(id: string) {
        return this.prisma.shipmentStatusLog.findMany({
            where: { shipmentId: id },
            include: { changer: { select: { id: true, name: true, role: true } } },
            orderBy: { createdAt: 'desc' }
        });
    }

    /** Role-specific shipment alerts: customer, merchant (store), and admins each get tailored copy. */
    private async notifyRelevantUsers(
        orderId: string,
        status: ShipmentStatus,
        note?: string,
        customsDelayInput?: string
    ) {
        const order = await this.prisma.order.findUnique({ where: { id: orderId } });
        if (!order?.customerId) return;

        if (!STATUS_LABELS[status]) return;

        const labels = STATUS_LABELS[status];
        const customsSuffixAr = (status === ShipmentStatus.CUSTOMS_DELAY)
            ? `\n${labels.ar}${customsDelayInput ? '\n' + customsDelayInput : ''}`
            : '';
        const customsSuffixEn = (status === ShipmentStatus.CUSTOMS_DELAY)
            ? `\n${labels.en}${customsDelayInput ? '\n' + customsDelayInput : ''}`
            : '';

        const bodies = buildShipmentNotifyBodies(
            status,
            order.orderNumber,
            note,
            customsSuffixAr,
            customsSuffixEn,
        );

        await this.notifications.create({
            recipientId: order.customerId,
            recipientRole: 'CUSTOMER',
            titleAr: 'تحديث شحنتك 🚚',
            titleEn: 'Your shipment update 🚚',
            messageAr: bodies.customer.ar,
            messageEn: bodies.customer.en,
            type: 'SHIPMENT_UPDATE',
            link: `/customer/orders/${order.id}`,
            metadata: { orderId: order.id, orderNumber: order.orderNumber },
        });

        const acceptedOffer = await this.prisma.offer.findFirst({
            where: {
                orderId,
                status: { in: ['ACCEPTED', 'COMPLETED', 'SHIPPED', 'DELIVERED'] },
            },
            select: { storeId: true },
        });

        if (acceptedOffer?.storeId) {
            await this.notifications.notifyMerchantByStoreId(acceptedOffer.storeId, {
                titleAr: 'تحديث شحن طلبك 📦',
                titleEn: 'Order shipment update 📦',
                messageAr: bodies.merchant.ar,
                messageEn: bodies.merchant.en,
                type: 'SHIPMENT_UPDATE',
                link: `/merchant/orders/${order.id}`,
                metadata: { orderId: order.id, orderNumber: order.orderNumber },
            });
        }

        await this.notifications.notifyAdmins({
            titleAr: 'تحديث حالة شحنة 📋',
            titleEn: 'Shipment status update 📋',
            messageAr: bodies.admin.ar,
            messageEn: bodies.admin.en,
            type: 'SHIPMENT_UPDATE',
            link: `/admin/dashboard/shipping`,
        });
    }
}
