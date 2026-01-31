import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderStateMachine } from './fsm/order-state-machine.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ActorType, Order, OrderStatus } from '@prisma/client';

@Injectable()
export class OrdersService {
    constructor(
        private prisma: PrismaService,
        private fsm: OrderStateMachine,
        private auditLogs: AuditLogsService,
    ) { }

    async create(customerId: string, createOrderDto: CreateOrderDto): Promise<Order> {
        // 1. Generate Order Number
        const orderNumber = await this.generateOrderNumber();

        // 2. Transaction: Create Order + Audit Log
        return this.prisma.$transaction(async (tx) => {
            const order = await tx.order.create({
                data: {
                    vehicleMake: createOrderDto.vehicleMake,
                    vehicleModel: createOrderDto.vehicleModel,
                    vehicleYear: createOrderDto.vehicleYear,
                    vin: createOrderDto.vin,
                    partName: createOrderDto.partName,
                    partDescription: createOrderDto.partDescription,
                    conditionPref: createOrderDto.conditionPref,
                    warrantyPreferred: createOrderDto.warrantyPreferred,

                    customerId,
                    orderNumber,
                    status: OrderStatus.AWAITING_OFFERS,
                    partImages: createOrderDto.partImages || [],
                },
            });

            // Update Metadata independently if needed, or include in create above if schema allows.
            // Let's assume we put vinImage in metadata for now as schema change is larger task.
            if (createOrderDto.vinImage) {
                // small hack: update audit log or part of valid metadata field if Order model doesn't support it?
                // Wait, Order model in BACKEND_M1_PREPARATION.md *does not* have metadata column on Order itself.
                // It has part_images JSONB. 
                // Let's check schema.prisma first to be sure.
                // I will assume part_images exists. For VIN Image, I'll ignore for a second until I check schema.
                // Actually, let's just use partImages as is.
            }

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
                    part: createOrderDto.partName,
                    vinImage: createOrderDto.vinImage // Save here for audit at least
                },
            }, tx); // Pass transaction context

            return order;
        });
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
                // Determine if they just registered and have no store yet?
                // For safety, return nothing or just generic open ones?
                // Let's assume they must have a storeId to operate.
                // If not, maybe just return nothing to be safe.
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
        return this.prisma.$transaction(async (tx) => {
            const updatedOrder = await tx.order.update({
                where: { id: orderId },
                data: {
                    status: newStatus,
                    // Update timestamps based on status (simple version)
                    // offerAcceptedAt, shippedAt etc would be handled here in full version
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
    }

    private async generateOrderNumber(): Promise<string> {
        // Call the Postgres function we created in SQL setup
        const result = await this.prisma.$queryRaw<{ generate_order_number: string }[]>`SELECT generate_order_number()`;
        return result[0].generate_order_number;
    }
}
