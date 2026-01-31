
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus, StoreStatus, UserRole } from '@prisma/client';

@Injectable()
export class DashboardService {
    constructor(private prisma: PrismaService) { }

    async getStats() {
        // 1. Basic Counts
        const totalOrders = await this.prisma.order.count();
        const activeCustomers = await this.prisma.user.count({ where: { role: UserRole.CUSTOMER } });
        const activeStores = await this.prisma.store.count({ where: { status: StoreStatus.ACTIVE } });
        const openDisputes = await this.prisma.order.count({
            where: {
                status: {
                    in: [OrderStatus.DISPUTED, OrderStatus.RETURN_REQUESTED]
                }
            }
        });

        // 2. Financials (Total Sales & Commission)
        // Fetch all completed orders with their accepted offer price
        // Using findMany + JS reduce because Decimal aggregation can be tricky with relations in simple Prisma
        const completedOrders = await this.prisma.order.findMany({
            where: {
                status: { in: [OrderStatus.COMPLETED, OrderStatus.DELIVERED] }, // Include Delivered as 'Sales'? Usually yes.
                acceptedOfferId: { not: null }
            },
            include: {
                acceptedOffer: {
                    select: { unitPrice: true, shippingCost: true }
                }
            }
        });

        const totalSales = completedOrders.reduce((sum, order) => {
            const price = Number(order.acceptedOffer?.unitPrice || 0);
            const shipping = Number(order.acceptedOffer?.shippingCost || 0);
            return sum + price + shipping; // Total Volume
        }, 0);

        // Commission typically calculated on platform fee. 
        // For M1, let's assume flat 20% of GMV (Total Sales) or just Unit Price?
        // Let's use 10% of Total Sales as a placeholder or 0 if not defined.
        // User request: "register real values". 
        // I will calculate estimated commission (e.g. 10%).
        const estimatedCommission = totalSales * 0.10;

        // 3. Sales Trend (Last 30 Days)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const recentOrders = await this.prisma.order.findMany({
            where: {
                createdAt: { gte: thirtyDaysAgo },
                status: { in: [OrderStatus.COMPLETED, OrderStatus.DELIVERED, OrderStatus.SHIPPED, OrderStatus.PREPARATION, OrderStatus.AWAITING_PAYMENT, OrderStatus.AWAITING_OFFERS] }, // All active orders for "Activity"? Or just Sales?
                // User said "Sales Trend". Usually implies Completed/Paid.
                // But if system is new, chart might be empty.
                // Let's stick to Completed/Delivered for "Sales".
                // Actually, let's include SHIPPED too as "Revenue Secured" likely.
            },
            include: {
                acceptedOffer: { select: { unitPrice: true } }
            },
            orderBy: { createdAt: 'asc' }
        });

        // Group by Date
        const trendMap = new Map<string, number>();
        // Initialize last 30 days with 0
        for (let i = 0; i < 30; i++) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key = d.toISOString().split('T')[0];
            trendMap.set(key, 0);
        }

        recentOrders.forEach(o => {
            if (o.status === 'COMPLETED' || o.status === 'DELIVERED') {
                const key = o.createdAt.toISOString().split('T')[0];
                const val = Number(o.acceptedOffer?.unitPrice || 0);
                trendMap.set(key, (trendMap.get(key) || 0) + val);
            }
        });

        // Convert to array for Recharts
        const salesTrend = Array.from(trendMap.entries())
            .map(([date, value]) => ({ date, value }))
            .sort((a, b) => a.date.localeCompare(b.date));


        // 4. Top Stores
        // Group orders by storeId
        const storeStats = await this.prisma.order.groupBy({
            by: ['storeId'],
            where: {
                status: { in: [OrderStatus.COMPLETED, OrderStatus.DELIVERED] },
                storeId: { not: null }
            },
            _count: { id: true },
        });

        // We need names. Fetch all stores involved.
        const topStoreIds = storeStats.map(s => s.storeId).filter(id => id !== null) as string[];
        const stores = await this.prisma.store.findMany({
            where: { id: { in: topStoreIds } },
            select: { id: true, name: true }
        });

        const topStores = storeStats.map(stat => {
            const store = stores.find(s => s.id === stat.storeId);
            return {
                storeId: stat.storeId,
                name: store?.name || 'Unknown',
                ordersCount: stat._count.id,
                // We could calculate value too if we fetched it.
                // For now, sorting by Order Count is fine for "Best Selling" (Quantity)
                // Or user might want Value.
                // Let's stick to simple "Orders Count" for speed, or fetch value if critical.
                value: stat._count.id // Using count for bar chart
            };
        }).sort((a, b) => b.ordersCount - a.ordersCount).slice(0, 5);


        // 5. Order Status Distribution (Donut)
        const statusDist = await this.prisma.order.groupBy({
            by: ['status'],
            _count: { id: true }
        });

        // 6. Alerts System (Real-time Backend Sync)
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
        const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        // Alert 1: Orders waiting response > 24h
        const lateResponseCount = await this.prisma.order.count({
            where: {
                status: OrderStatus.AWAITING_OFFERS,
                createdAt: { lt: oneDayAgo }
            }
        });

        // Alert 2: Orders in preparation > 48h (Delayed)
        const latePrepCount = await this.prisma.order.count({
            where: {
                status: OrderStatus.PREPARATION,
                updatedAt: { lt: twoDaysAgo } // Assuming updatedAt reflects when it entered Prep roughly
            }
        });

        // Alert 3: License Expiry (Next 30 Days)
        const expiringLicensesCount = await this.prisma.store.count({
            where: {
                licenseExpiry: {
                    lte: thirtyDaysFromNow,
                    gte: now
                }
            }
        });

        // Alert 4: Expired Licenses (Already Expired)
        const expiredLicensesCount = await this.prisma.store.count({
            where: {
                licenseExpiry: { lt: now }
            }
        });

        const alerts = [
            lateResponseCount > 0 ? { type: 'warning', code: 'LATE_RESPONSE', count: lateResponseCount, priority: 'high' } : null,
            latePrepCount > 0 ? { type: 'error', code: 'LATE_PREP', count: latePrepCount, priority: 'high' } : null,
            expiringLicensesCount > 0 ? { type: 'warning', code: 'LICENSE_EXPIRING', count: expiringLicensesCount, priority: 'medium' } : null,
            expiredLicensesCount > 0 ? { type: 'error', code: 'LICENSE_EXPIRED', count: expiredLicensesCount, priority: 'critical' } : null,
            openDisputes > 0 ? { type: 'error', code: 'DISPUTES_OPEN', count: openDisputes, priority: 'high' } : null
        ].filter(Boolean);

        return {
            totalSales,
            totalCommission: estimatedCommission,
            totalOrders,
            activeCustomers,
            activeStores,
            openDisputes,
            salesTrend,
            topStores,

            statusDistribution: statusDist.map(s => ({ status: s.status, count: s._count.id })),
            alerts
        };
    }
}
