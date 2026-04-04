import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class InvoicesService {
    constructor(private prisma: PrismaService) { }

    async getUserInvoices(userId: string) {
        // Fetch all invoices for this user with full relational data
        // Includes: order → customer, store, parts, shipping addresses, accepted offers → store + orderPart
        return this.prisma.invoice.findMany({
            where: { customerId: userId },
            include: {
                order: {
                    include: {
                        customer: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                phone: true,
                                countryCode: true,
                                country: true,
                            }
                        },
                        store: true,
                        parts: true,
                        shippingAddresses: true,
                        offers: {
                            where: { status: 'accepted' },
                            include: {
                                store: true,
                                orderPart: true
                            }
                        }
                    }
                }
            },
            orderBy: { issuedAt: 'desc' }
        });
    }

    async getInvoiceById(userId: string, id: string) {
        const invoice = await this.prisma.invoice.findFirst({
            where: { id, customerId: userId },
            include: {
                order: {
                    include: {
                        customer: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                phone: true,
                                countryCode: true,
                                country: true,
                            }
                        },
                        store: true,
                        parts: true,
                        shippingAddresses: true,
                        offers: {
                            where: { status: 'accepted' },
                            include: {
                                store: true,
                                orderPart: true
                            }
                        }
                    }
                }
            }
        });

        if (!invoice) {
            throw new NotFoundException('Invoice not found');
        }

        return invoice;
    }

    async getMerchantInvoices(userId: string) {
        // 1. Get the store owned by this user
        const store = await this.prisma.store.findUnique({
            where: { ownerId: userId }
        });

        if (!store) return [];

        // 2. Fetch all payment IDs for offers from this store
        const payments = await this.prisma.paymentTransaction.findMany({
            where: { 
                offer: { storeId: store.id },
                status: 'SUCCESS'
            },
            select: { id: true }
        });

        const paymentIds = payments.map(p => p.id);

        if (paymentIds.length === 0) return [];

        // 3. Fetch invoices matching those payment IDs
        return this.prisma.invoice.findMany({
            where: {
                paymentId: { in: paymentIds }
            },
            include: {
                order: {
                    include: {
                        customer: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                phone: true,
                                countryCode: true,
                                country: true,
                            }
                        },
                        store: true,
                        shippingAddresses: true,
                        parts: true,
                        offers: {
                            where: { storeId: store.id, status: 'accepted' },
                            include: {
                                store: true,
                                orderPart: true
                            }
                        }
                    }
                }
            },
            orderBy: { issuedAt: 'desc' }
        });
    }

    /**
     * Get all invoices for a specific order.
     * Admin and Participants can use this to populate the OrderInvoicesPanel.
     */
    async getInvoicesByOrder(orderId: string) {
        return this.prisma.invoice.findMany({
            where: { orderId },
            include: {
                order: {
                    include: {
                        customer: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                phone: true,
                                countryCode: true,
                                country: true,
                            }
                        },
                        store: true,
                        parts: true,
                        shippingAddresses: true,
                        offers: {
                            where: { status: 'accepted' },
                            include: {
                                store: true,
                                orderPart: true
                            }
                        }
                    }
                }
            },
            orderBy: { issuedAt: 'asc' }
        });
    }
}
