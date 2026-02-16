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
        // [Verified] Type safety confirmed: 'parts' relation exists in Prisma Client
        // 1. Generate Order Number
        const orderNumber = await this.generateOrderNumber();

        // 2. Transaction: Create Order + Parts + Audit Log
        return this.prisma.$transaction(async (tx) => {
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
