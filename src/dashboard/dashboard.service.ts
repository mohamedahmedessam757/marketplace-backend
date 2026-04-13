
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus, StoreStatus, UserRole } from '@prisma/client';

@Injectable()
export class DashboardService {
    constructor(private prisma: PrismaService) { }

    async getStats(startDateStr?: string, endDateStr?: string) {
        // 0. Base Timestamps setup for queries
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        
        // Use provided dates or fallback to defaults
        const startDate = startDateStr ? new Date(startDateStr) : thirtyDaysAgo;
        const endDate = endDateStr ? new Date(endDateStr) : now;

        // For trend comparisons (Last period)
        const periodDiff = endDate.getTime() - startDate.getTime();
        const prevStartDate = new Date(startDate.getTime() - periodDiff);
        const prevEndDate = new Date(startDate.getTime());

        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
        const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        // Define valid sales statuses
        const activeSalesStatuses: OrderStatus[] = [
            OrderStatus.PREPARATION, 
            OrderStatus.SHIPPED, 
            OrderStatus.DELIVERED, 
            OrderStatus.COMPLETED
        ];

        // 1. Massive Concurrent Query execution
        const [
            totalOrders,
            activeCustomers,
            activeStores,
            openDisputes,
            // Accurate Financials from PaymentTransaction
            financialStats,
            prevFinancialStats,
            // Sales Trend
            trendTransactions,
            // Top Stores with Revenue
            storeRevenueStats,
            // Donut Distribution
            statusDist,
            // Alerts
            lateResponseCount,
            latePrepCount,
            expiringLicensesCount,
            expiredLicensesCount,
            lastOrders
        ] = await Promise.all([
            this.prisma.order.count({
                where: { createdAt: { gte: startDate, lte: endDate } }
            }),
            this.prisma.user.count({ where: { role: UserRole.CUSTOMER } }),
            this.prisma.store.count({ where: { status: StoreStatus.ACTIVE } }),
            this.prisma.order.count({ where: { status: { in: [OrderStatus.DISPUTED, OrderStatus.RETURN_REQUESTED] } } }),
            
            // Current Period Financials
            this.prisma.paymentTransaction.aggregate({
                where: { 
                    status: 'SUCCESS',
                    createdAt: { gte: startDate, lte: endDate }
                },
                _sum: { totalAmount: true, commission: true }
            }),
            
            // Previous Period Financials (for trend calculation)
            this.prisma.paymentTransaction.aggregate({
                where: { 
                    status: 'SUCCESS',
                    createdAt: { gte: prevStartDate, lte: prevEndDate }
                },
                _sum: { totalAmount: true, commission: true }
            }),

            // Sales Trend (Timeline)
            this.prisma.paymentTransaction.findMany({
                where: {
                    status: 'SUCCESS',
                    createdAt: { gte: startDate, lte: endDate },
                },
                select: { createdAt: true, totalAmount: true },
                orderBy: { createdAt: 'asc' }
            }),

            // Top Stores logic: Group by storeId inside PaymentTransaction or join
            this.prisma.paymentTransaction.groupBy({
                by: ['offerId'], // We'll link this to store later, or use Order relation
                where: {
                    status: 'SUCCESS',
                    createdAt: { gte: startDate, lte: endDate }
                },
                _sum: { totalAmount: true },
                _count: { id: true }
            }),

            this.prisma.order.groupBy({
                by: ['status'],
                _count: { id: true }
            }),
            this.prisma.order.count({ where: { status: OrderStatus.AWAITING_OFFERS, createdAt: { lt: oneDayAgo } } }),
            this.prisma.order.count({ where: { status: OrderStatus.PREPARATION, updatedAt: { lt: twoDaysAgo } } }),
            this.prisma.store.count({ where: { licenseExpiry: { lte: thirtyDaysFromNow, gte: now } } }),
            this.prisma.store.count({ where: { licenseExpiry: { lt: now } } }),
            
            this.prisma.order.findMany({
                take: 5,
                orderBy: { createdAt: 'desc' },
                include: {
                    customer: { select: { id: true, name: true, avatar: true } },
                    acceptedOffer: {
                        select: {
                            unitPrice: true,
                            shippingCost: true,
                            store: { select: { id: true, name: true, logo: true, rating: true } }
                        }
                    },
                    offers: {
                        include: { store: { select: { name: true } } }
                    },
                    _count: { select: { offers: true } }
                }
            })
        ]);

        // 2. Compute Financials
        const totalSales = Number(financialStats._sum.totalAmount || 0);
        const totalCommission = Number(financialStats._sum.commission || 0);
        
        const prevSales = Number(prevFinancialStats._sum.totalAmount || 0);
        const salesTrendPercent = prevSales > 0 ? ((totalSales - prevSales) / prevSales) * 100 : 0;

        // 3. Compute Timeline Trend Map
        const trendMap = new Map<string, number>();
        const diffDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 3600 * 24));
        for (let i = 0; i <= diffDays; i++) {
            const d = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
            trendMap.set(d.toISOString().split('T')[0], 0);
        }

        trendTransactions.forEach(tx => {
            const key = tx.createdAt.toISOString().split('T')[0];
            if (trendMap.has(key)) {
                trendMap.set(key, trendMap.get(key)! + Number(tx.totalAmount));
            }
        });

        const salesTrend = Array.from(trendMap.entries())
            .map(([date, value]) => ({ date, value }))
            .sort((a, b) => a.date.localeCompare(b.date));

        // 4. Resolve Top Stores details
        // Since groupBy was on offerId (or store would be better if denormalized), we fetch store via offers
        const topStoresList = await Promise.all(
            storeRevenueStats.map(async (stat) => {
                const offer = await this.prisma.offer.findUnique({
                    where: { id: stat.offerId },
                    select: { store: { select: { id: true, name: true, logo: true, rating: true } } }
                });
                return {
                    storeId: offer?.store?.id,
                    name: offer?.store?.name || 'Unknown',
                    logo: offer?.store?.logo,
                    rating: Number(offer?.store?.rating || 0),
                    revenue: Number(stat._sum.totalAmount || 0),
                    ordersCount: stat._count.id
                };
            })
        );

        // Aggregate by storeId (in case one store has multiple offers)
        const aggregatedStores = topStoresList.reduce((acc, curr) => {
            if (!curr.storeId) return acc;
            if (!acc[curr.storeId]) {
                acc[curr.storeId] = { ...curr };
            } else {
                acc[curr.storeId].revenue += curr.revenue;
                acc[curr.storeId].ordersCount += curr.ordersCount;
            }
            return acc;
        }, {} as Record<string, any>);

        const topStores = Object.values(aggregatedStores)
            .sort((a, b) => b.revenue - a.revenue)
            .slice(0, 5);

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
            totalCommission,
            salesTrendPercent: Number(salesTrendPercent.toFixed(1)),
            totalOrders,
            activeCustomers,
            activeStores,
            openDisputes,
            salesTrend,
            topStores,
            recentOrders: lastOrders,
            statusDistribution: statusDist.map(s => ({ status: s.status, count: s._count.id })),
            alerts
        };
    }

}
