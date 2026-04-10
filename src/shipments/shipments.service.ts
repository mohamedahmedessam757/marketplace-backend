import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateShipmentDto } from './dto/create-shipment.dto';
import { UpdateShipmentStatusDto } from './dto/update-shipment-status.dto';
import { ShipmentStatus } from '@prisma/client';

// Premium Bilingual status labels for notifications (Enthusiastic & Clear)
const STATUS_LABELS: Record<ShipmentStatus, { ar: string; en: string }> = {
    RECEIVED_AT_HUB:           { ar: 'وصلت شحنتك إلى مستودعنا الرئيسي 🏢 نحن الآن بصدد فرزها وتجهيزها.', en: 'Your shipment arrived at our main hub 🏢 We are now sorting and preparing it.' },
    QUALITY_CHECK_PASSED:      { ar: 'اجتازت الشحنة فحص الجودة بنجاح! ✅ نحن نحرص دائماً على تسليمك الأفضل.', en: 'Shipment passed quality check successfully! ✅ We always ensure you receive the best.' },
    PACKAGED_FOR_SHIPPING:     { ar: 'تم تغليف طلبك بعناية 📦 وهو الآن في وضع الاستعداد للانطلاق.', en: 'Your order is carefully packaged 📦 and is ready to head out.' },
    AWAITING_CARRIER_PICKUP:   { ar: 'في انتظار مندوب شركة الشحن 🚚 لاستلام طردك الثمين.', en: 'Awaiting shipping courier 🚚 to pick up your precious package.' },
    PICKED_UP_BY_CARRIER:      { ar: 'انطلقت الشحنة! 🚀 استلمت شركة الشحن طردك وهي في طريقها إليك.', en: 'Shipment has launched! 🚀 The courier picked up your package and is on the way.' },
    IN_TRANSIT_TO_DESTINATION: { ar: 'شحنتك بين أيدٍ أمينة 🛣️ وهي الآن تتحرك نحو وجهتها النهائية.', en: 'Your shipment is in safe hands 🛣️ and is moving towards its destination.' },
    ARRIVED_AT_LOCAL_FACILITY: { ar: 'وصلت الشحنة إلى مركز التوزيع المحلي 📍 أصبحت قريبة جداً منك.', en: 'Shipment reached the local distribution hub 📍 It is very close now.' },
    CUSTOMS_CLEARANCE:         { ar: 'إجراءات روتينية 🛠️ الشحنة حالياً في مرحلة التخليص الجمركي.', en: 'Routine procedures 🛠️ Shipment is currently in customs clearance.' },
    AT_LOCAL_WAREHOUSE:        { ar: 'وصلت إلى مدينتك! 🌆 الشحنة الآن في مستودع الشحن المحلي بانتظار خروج المندوب.', en: 'Reached your city! 🌆 Shipment is at the local warehouse awaiting delivery.' },
    OUT_FOR_DELIVERY:          { ar: 'استعد للاستلام! 🛵 المندوب في الطريق إليك اليوم، يرجى التواجد.', en: 'Get ready! 🛵 The courier is on the way to you today, please be available.' },
    DELIVERY_ATTEMPTED:        { ar: 'حاولنا الوصول إليك 🔔 ولكن لم نتمكن من التسليم. سنعيد المحاولة قريباً.', en: 'We tried to reach you 🔔 but could not deliver. We will retry soon.' },
    DELIVERED_TO_CUSTOMER:     { ar: 'تم التسليم بنجاح! ✅ نأمل أن تكون تجربتك معنا رائعة، يومك سعيد.', en: 'Delivered successfully! ✅ We hope you had a great experience with us.' },
    RETURN_TO_SENDER_INITIATED:{ ar: 'بدء إجراءات الإرجاع 🔄 لضمان وصول الشحنة للمرسل بأمان.', en: 'Return to sender initiated 🔄 to ensure safe arrival.' },
    RETURNED_TO_SENDER:        { ar: 'تم إرجاع الطرد للمرسل بنجاح.', en: 'Returned to sender successfully.' },
};

@Injectable()
export class ShipmentsService {
    constructor(
        private prisma: PrismaService,
        private notifications: NotificationsService
    ) {}

    async create(data: CreateShipmentDto, userId: string) {
        const existing = await this.prisma.shipment.findFirst({
            where: { orderId: data.orderId }
        });
        if (existing) {
            // Idempotent: return existing shipment instead of throwing
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
                updatedBy: userId,
                // Starts at RECEIVED_AT_HUB - the admin will update the 12-step status
                status: 'RECEIVED_AT_HUB',
            }
        });

        await this.prisma.shipmentStatusLog.create({
            data: {
                shipmentId: shipment.id,
                fromStatus: null,
                toStatus: 'RECEIVED_AT_HUB',
                changedBy: userId,
                source: 'MANUAL',
                notes: 'Shipment created by merchant request'
            }
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

        // When carrier picks up → update order to SHIPPED
        if (isPickedUp && shipment.order) {
            await this.prisma.order.update({
                where: { id: shipment.orderId },
                data: { status: 'SHIPPED' }
            });
        }

        // When delivered → update order to DELIVERED
        if (isDelivered && shipment.order) {
            await this.prisma.order.update({
                where: { id: shipment.orderId },
                data: { status: 'DELIVERED' }
            });
        }

        // Send rich bilingual notifications
        await this.notifyRelevantUsers(shipment.orderId, newStatus, data.notes, data.customsDelayNote ?? shipment.customsDelayNote);

        return updated;
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
        return this.prisma.shipment.findMany({
            include: {
                order: {
                    select: {
                        orderNumber: true,
                        status: true,
                        customer: { select: { id: true, name: true } }
                    }
                },
                updater: { select: { id: true, name: true } }
            },
            orderBy: { updatedAt: 'desc' }
        });
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
                        carrierName: true,
                        status: true,
                        estimatedDelivery: true,
                        updatedAt: true,
                    },
                    take: 1,
                    orderBy: { updatedAt: 'desc' }
                }
            },
            orderBy: { updatedAt: 'desc' }
        });

        return (orders as any[]).map(order => {
            const s = order.shipments && order.shipments.length > 0 ? order.shipments[0] : null;
            const addr = order.shippingAddresses && order.shippingAddresses.length > 0 ? order.shippingAddresses[0] : null;
            
            // Fallback to the offers array if the acceptedOffer relation is null
            let offer = order.acceptedOffer;
            if (!offer && order.offers && order.offers.length > 0) {
                offer = order.offers[0];
            }
            
            return {
                id: s?.id || order.id,
                orderId: order.id,
                trackingNumber: s?.trackingNumber || order.orderNumber,
                carrier: s?.carrierName || null,
                status: s?.status || (order.status === 'READY_FOR_SHIPPING' ? 'RECEIVED_AT_HUB' : order.status === 'DELIVERED' ? 'DELIVERED_TO_CUSTOMER' : 'IN_TRANSIT_TO_DESTINATION'),
                estimatedDelivery: null, 
                updatedAt: s?.updatedAt || order.updatedAt,
                orderNumber: order.orderNumber,
                vehicleMake: order.vehicleMake,
                vehicleModel: order.vehicleModel,
                partName: order.partName,
                partDescription: order.partDescription,
                partImages: order.partImages || [],
                offerImage: offer?.offerImage || null,
                weightKg: offer?.weightKg ? Number(offer.weightKg) : null,
                // Constructed items array for ShipmentCard
                items: [{ 
                    name: `${order.vehicleMake} ${order.vehicleModel} - ${order.partName}`,
                    quantity: 1 
                }],
                // New Fields for Premium View
                storeCode: order.store?.storeCode || offer?.store?.storeCode || 'STR-TASHLEH',
                customerCode: `CUST-${order.customerId.substring(0, 8).toUpperCase()}`,
                shippingAddress: addr ? `${addr.details}, ${addr.city}, ${addr.country}` : 'Pending Address',
                customerCountry: addr?.country || 'N/A',
                customerCity: addr?.city || 'N/A',
                customerDetails: addr?.details || 'N/A',
                origin: 'Tashleh Hub',
                destination: addr ? `${addr.city}, ${addr.country}` : 'Customer Address',
            };
        });
    }

    async getLogs(id: string) {
        return this.prisma.shipmentStatusLog.findMany({
            where: { shipmentId: id },
            include: { changer: { select: { id: true, name: true, role: true } } },
            orderBy: { createdAt: 'desc' }
        });
    }

    private async notifyRelevantUsers(
        orderId: string,
        status: ShipmentStatus,
        note?: string,
        customsNote?: string
    ) {
        const order = await this.prisma.order.findUnique({ where: { id: orderId } });
        if (!order) return;

        const labels = STATUS_LABELS[status];
        if (!labels) return;

        // Attach customs delay message if applicable
        const customsSuffixAr = (status === ShipmentStatus.CUSTOMS_CLEARANCE && customsNote)
            ? `\n⚠️ نعتذر عن التأخير، الشحنة حالياً لدى الجمارك. ${customsNote}`
            : '';
        const customsSuffixEn = (status === ShipmentStatus.CUSTOMS_CLEARANCE && customsNote)
            ? `\n⚠️ Apologies for the delay, shipment is currently at Customs. ${customsNote}`
            : '';

        const notifyData = {
            titleAr: 'تحديث شحنتك 🚚',
            titleEn: 'Shipment Update 🚚',
            messageAr: `طلب #${order.orderNumber}: ${labels.ar}${note ? '\n' + note : ''}${customsSuffixAr}`,
            messageEn: `Order #${order.orderNumber}: ${labels.en}${note ? '\n' + note : ''}${customsSuffixEn}`,
            type: 'ORDER_UPDATE',
            link: `/dashboard/orders/${order.id}`,
        };

        // Notify Customer
        await this.notifications.create({ ...notifyData, recipientId: order.customerId, recipientRole: 'CUSTOMER' });

        // Notify Vendor (via accepted offer → store owner)
        const acceptedOffer = await this.prisma.offer.findFirst({
            where: {
                orderId: orderId,
                status: { in: ['ACCEPTED', 'COMPLETED', 'SHIPPED', 'DELIVERED'] }
            }
        });

        if (acceptedOffer?.storeId) {
            const store = await this.prisma.store.findUnique({ where: { id: acceptedOffer.storeId } });
            if (store?.ownerId) {
                await this.notifications.create({ ...notifyData, recipientId: store.ownerId, recipientRole: 'MERCHANT' });
            }
        }

        // Notify Admins
        const admins = await this.prisma.user.findMany({ where: { role: 'ADMIN' } });
        await Promise.all(
            admins.map(admin => 
                this.notifications.create({ ...notifyData, recipientId: admin.id, recipientRole: 'ADMIN' })
            )
        );
    }
};
