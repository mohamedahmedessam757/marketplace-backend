
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus, StoreStatus, UserRole } from '@prisma/client';
import {
    buildAdminDateRange,
    buildPreviousAdminDateRange,
    computeAdminFinancialKpis,
    computeSalesTrend,
    computeTopEarners,
} from '../payments/admin-financial-metrics.util';

@Injectable()
export class DashboardService {
    constructor(private prisma: PrismaService) { }

    async getStats(startDateStr?: string, endDateStr?: string) {
        const now = new Date();
        const defaultStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        const range = buildAdminDateRange({
            startDate: startDateStr || defaultStart.toISOString().split('T')[0],
            endDate: endDateStr || now.toISOString().split('T')[0],
        });
        const prevRange = buildPreviousAdminDateRange(range);

        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
        const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        const orderDateFilter =
            range.startDate && range.endDate
                ? { createdAt: { gte: range.startDate, lte: range.endDate } }
                : {};

        const [
            totalOrders,
            activeCustomers,
            activeStores,
            openDisputes,
            kpis,
            prevKpis,
            salesTrendPoints,
            topEarners,
            statusDist,
            lateResponseCount,
            latePrepCount,
            expiringLicensesCount,
            expiredLicensesCount,
            stalledVerificationCount,
            lastOrders,
        ] = await Promise.all([
            this.prisma.order.count({ where: orderDateFilter }),
            this.prisma.user.count({ where: { role: UserRole.CUSTOMER } }),
            this.prisma.store.count({ where: { status: StoreStatus.ACTIVE } }),
            (async () => {
                const [openReturns, openDisputes] = await Promise.all([
                    this.prisma.returnRequest.count({
                        where: {
                            status: {
                                notIn: ['CLOSED', 'REJECTED', 'CANCELLED', 'REFUNDED', 'RESOLVED'],
                            },
                        },
                    }),
                    this.prisma.dispute.count({
                        where: {
                            status: { notIn: ['CLOSED', 'RESOLVED', 'CANCELLED'] },
                        },
                    }),
                ]);
                return openReturns + openDisputes;
            })(),
            computeAdminFinancialKpis(this.prisma, range),
            computeAdminFinancialKpis(this.prisma, prevRange),
            computeSalesTrend(this.prisma, range),
            computeTopEarners(this.prisma, range, 5),
            this.prisma.order.groupBy({
                by: ['status'],
                where: orderDateFilter,
                _count: { id: true },
            }),
            this.prisma.order.count({
                where: {
                    status: {
                        in: [
                            OrderStatus.AWAITING_OFFERS,
                            OrderStatus.COLLECTING_OFFERS,
                            OrderStatus.AWAITING_SELECTION,
                        ],
                    },
                    createdAt: { lt: oneDayAgo },
                },
            }),
            this.prisma.order.count({
                where: {
                    status: {
                        in: [
                            OrderStatus.PREPARATION,
                            OrderStatus.DELAYED_PREPARATION,
                        ],
                    },
                    updatedAt: { lt: twoDaysAgo },
                },
            }),
            this.prisma.store.count({
                where: {
                    licenseExpiry: { lte: thirtyDaysFromNow, gte: now },
                },
            }),
            this.prisma.store.count({
                where: { licenseExpiry: { lt: now } },
            }),
            this.prisma.order.count({
                where: {
                    status: OrderStatus.VERIFICATION,
                    updatedAt: { lt: oneDayAgo },
                },
            }),
            this.prisma.order.findMany({
                take: 5,
                orderBy: { createdAt: 'desc' },
                include: {
                    customer: { select: { id: true, name: true, avatar: true } },
                    acceptedOffer: {
                        select: {
                            unitPrice: true,
                            shippingCost: true,
                            store: {
                                select: {
                                    id: true,
                                    name: true,
                                    logo: true,
                                    rating: true,
                                },
                            },
                        },
                    },
                    offers: {
                        include: { store: { select: { name: true } } },
                    },
                    _count: { select: { offers: true } },
                },
            }),
        ]);

        const totalSales = kpis.grossSales;
        const totalCommission = kpis.netCommission;
        const prevSales = prevKpis.grossSales;
        const salesTrendPercent =
            prevSales > 0
                ? ((totalSales - prevSales) / prevSales) * 100
                : 0;

        const salesTrend = salesTrendPoints.map((point) => ({
            date: point.date,
            value: point.grossSales,
        }));

        const topStores = topEarners.map((store) => ({
            storeId: store.id,
            name: store.name,
            logo: store.logo,
            rating: Number(store.rating || 0),
            revenue: store.totalEarned,
            ordersCount: store.ordersCount,
        }));

        const alerts = [
            lateResponseCount > 0
                ? {
                      type: 'warning',
                      code: 'LATE_RESPONSE',
                      count: lateResponseCount,
                      priority: 'high',
                  }
                : null,
            latePrepCount > 0
                ? {
                      type: 'error',
                      code: 'LATE_PREP',
                      count: latePrepCount,
                      priority: 'high',
                  }
                : null,
            stalledVerificationCount > 0
                ? {
                      type: 'error',
                      code: 'STALLED_VERIFICATION',
                      count: stalledVerificationCount,
                      priority: 'medium',
                  }
                : null,
            expiringLicensesCount > 0
                ? {
                      type: 'warning',
                      code: 'LICENSE_EXPIRING',
                      count: expiringLicensesCount,
                      priority: 'medium',
                  }
                : null,
            expiredLicensesCount > 0
                ? {
                      type: 'error',
                      code: 'LICENSE_EXPIRED',
                      count: expiredLicensesCount,
                      priority: 'critical',
                  }
                : null,
            openDisputes > 0
                ? {
                      type: 'error',
                      code: 'DISPUTES_OPEN',
                      count: openDisputes,
                      priority: 'high',
                  }
                : null,
        ].filter(Boolean);

        return {
            totalSales,
            totalCommission,
            grossCommission: kpis.grossCommission,
            salesTrendPercent: Number(salesTrendPercent.toFixed(1)),
            totalOrders,
            activeCustomers,
            activeStores,
            openDisputes,
            salesTrend,
            topStores,
            recentOrders: lastOrders,
            statusDistribution: statusDist.map((s) => ({
                status: s.status,
                count: s._count.id,
            })),
            alerts,
        };
    }
}
