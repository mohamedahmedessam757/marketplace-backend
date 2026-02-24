
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus, StoreStatus, UserRole } from '@prisma/client';

@Injectable()
export class DashboardService {
    constructor(private prisma: PrismaService) { }

    async getStats() {
        // 0. Base Timestamps setup for queries
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
        const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        // 1. Massive Concurrent Query execution (11 parallel queries down from sequentially loading)
        const [
            totalOrders,
            activeCustomers,
            activeStores,
            openDisputes,
            completedOrders,
            recentOrders,
            storeStats,
            statusDist,
            lateResponseCount,
            latePrepCount,
            expiringLicensesCount,
            expiredLicensesCount
        ] = await Promise.all([
            this.prisma.order.count(),
            this.prisma.user.count({ where: { role: UserRole.CUSTOMER } }),
            this.prisma.store.count({ where: { status: StoreStatus.ACTIVE } }),
            this.prisma.order.count({ where: { status: { in: [OrderStatus.DISPUTED, OrderStatus.RETURN_REQUESTED] } } }),
            // Fetch completed for Total Sales & Commission
            this.prisma.order.findMany({
                where: {
                    status: { in: [OrderStatus.COMPLETED, OrderStatus.DELIVERED] },
                    acceptedOfferId: { not: null }
                },
                include: { acceptedOffer: { select: { unitPrice: true, shippingCost: true } } }
            }),
            // Sales Trend
            this.prisma.order.findMany({
                where: {
                    createdAt: { gte: thirtyDaysAgo },
                    status: { in: [OrderStatus.COMPLETED, OrderStatus.DELIVERED, OrderStatus.SHIPPED, OrderStatus.PREPARATION, OrderStatus.AWAITING_PAYMENT, OrderStatus.AWAITING_OFFERS] },
                },
                include: { acceptedOffer: { select: { unitPrice: true } } },
                orderBy: { createdAt: 'asc' }
            }),
            // Top Stores Initial Stats
            this.prisma.order.groupBy({
                by: ['storeId'],
                where: {
                    status: { in: [OrderStatus.COMPLETED, OrderStatus.DELIVERED] },
                    storeId: { not: null }
                },
                _count: { id: true },
            }),
            // Donut Distribution
            this.prisma.order.groupBy({
                by: ['status'],
                _count: { id: true }
            }),
            // Alert 1
            this.prisma.order.count({ where: { status: OrderStatus.AWAITING_OFFERS, createdAt: { lt: oneDayAgo } } }),
            // Alert 2
            this.prisma.order.count({ where: { status: OrderStatus.PREPARATION, updatedAt: { lt: twoDaysAgo } } }),
            // Alert 3
            this.prisma.store.count({ where: { licenseExpiry: { lte: thirtyDaysFromNow, gte: now } } }),
            // Alert 4
            this.prisma.store.count({ where: { licenseExpiry: { lt: now } } })
        ]);

        // 2. Compute Financials
        const totalSales = completedOrders.reduce((sum, order) => {
            const price = Number(order.acceptedOffer?.unitPrice || 0);
            const shipping = Number(order.acceptedOffer?.shippingCost || 0);
            return sum + price + shipping;
        }, 0);
        const estimatedCommission = totalSales * 0.10;

        // 3. Compute Timeline Trend Map
        const trendMap = new Map<string, number>();
        for (let i = 0; i < 30; i++) {
            const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
            trendMap.set(d.toISOString().split('T')[0], 0);
        }
        recentOrders.forEach(o => {
            if (o.status === 'COMPLETED' || o.status === 'DELIVERED') {
                const key = o.createdAt.toISOString().split('T')[0];
                const val = Number(o.acceptedOffer?.unitPrice || 0);
                if (trendMap.has(key)) {
                    trendMap.set(key, trendMap.get(key)! + val);
                }
            }
        });
        const salesTrend = Array.from(trendMap.entries())
            .map(([date, value]) => ({ date, value }))
            .sort((a, b) => a.date.localeCompare(b.date));

        // 4. Resolve Top Stores details
        const topStoreIds = storeStats.map(s => s.storeId).filter(id => id !== null) as string[];
        const storesArray = topStoreIds.length > 0 ? await this.prisma.store.findMany({
            where: { id: { in: topStoreIds } },
            select: { id: true, name: true }
        }) : [];

        const topStores = storeStats.map(stat => {
            const store = storesArray.find(s => s.id === stat.storeId);
            return {
                storeId: stat.storeId,
                name: store?.name || 'Unknown',
                ordersCount: stat._count.id,
                value: stat._count.id
            };
        }).sort((a, b) => b.ordersCount - a.ordersCount).slice(0, 5);

        // 5. Build Alerts array
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
