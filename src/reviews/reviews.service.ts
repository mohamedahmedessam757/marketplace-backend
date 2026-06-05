import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { UpdateReviewStatusDto } from './dto/update-review-status.dto';
import { CreateRatingImpactRuleDto, UpdateRatingImpactRuleDto } from './dto/rating-impact-rule.dto';
import { NotificationsService } from '../notifications/notifications.service';

import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { MerchantPerformanceService } from '../merchant-performance/merchant-performance.service';

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private auditLogs: AuditLogsService,
    @Inject(forwardRef(() => MerchantPerformanceService))
    private readonly merchantPerformance: MerchantPerformanceService,
  ) {}

  async create(customerId: string, createReviewDto: CreateReviewDto) {
    const orderId = createReviewDto.orderId;
    const offerId = createReviewDto.offerId?.trim() || null;

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        customerId: true,
        status: true,
        orderNumber: true,
        storeId: true,
        requestType: true,
        parts: { select: { id: true } },
        offers: {
          where: { status: { in: ['accepted', 'ACCEPTED'] } },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            storeId: true,
            orderPartId: true,
            fulfillmentStatus: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.customerId !== customerId) {
      throw new BadRequestException('You do not have permission to review this order');
    }

    const isMultiPart =
      order.requestType === 'multiple' || (order.parts?.length ?? 0) > 1;

    const reviewableStatuses = [
      'CLOSED',
      'DELIVERED',
      'PARTIALLY_DELIVERED',
      'COMPLETED',
      'WARRANTY_ACTIVE',
      'WARRANTY_EXPIRED',
    ];
    if (!reviewableStatuses.includes(String(order.status))) {
      throw new BadRequestException('Order must be delivered or closed to be reviewed');
    }

    let targetOffer = offerId
      ? order.offers.find((o) => o.id === offerId)
      : order.offers[0];

    if (isMultiPart && !offerId) {
      throw new BadRequestException(
        'offerId is required for multi-part orders. Select the specific part to review.',
      );
    }

    if (offerId && !targetOffer) {
      throw new BadRequestException('Offer does not belong to this order');
    }

    if (isMultiPart && targetOffer) {
      const eligibleFulfillment = ['DELIVERED', 'COMPLETED'];
      if (!eligibleFulfillment.includes(String(targetOffer.fulfillmentStatus))) {
        throw new BadRequestException(
          'This part must be delivered or completed before it can be reviewed',
        );
      }
    }

    const existingReview = await this.prisma.review.findFirst({
      where: {
        orderId,
        offerId: targetOffer?.id ?? null,
      },
      select: { id: true },
    });

    if (existingReview) {
      throw new BadRequestException('You have already reviewed this item');
    }

    let storeId = createReviewDto.storeId?.trim();
    if (!storeId) {
      storeId =
        targetOffer?.storeId ||
        order.offers?.[0]?.storeId ||
        (order.storeId && String(order.storeId)) ||
        undefined;
    }
    if (!storeId) {
      throw new BadRequestException(
        'Could not resolve store for this order. Please refresh and try again.',
      );
    }

    const review = await this.prisma.review.create({
      data: {
        orderId: createReviewDto.orderId,
        offerId: targetOffer?.id ?? null,
        customerId,
        storeId,
        rating: createReviewDto.rating,
        comment: createReviewDto.comment,
        adminStatus: 'PENDING',
      },
    });

    // 4–5. Side effects after response (faster submit for customer)
    void this.notifications
      .notifyAdmins({
        titleAr: 'تقييم جديد للمراجعة',
        titleEn: 'New Review for Moderation',
        messageAr: `قام العميل بوضع تقييم للطلب ${order.orderNumber}. بانتظار موافقتك.`,
        messageEn: `A customer has left a review on order ${order.orderNumber}. Awaiting your approval.`,
        type: 'alert',
        metadata: { reviewId: review.id },
      })
      .catch((err) => this.logger.warn('Review admin notify failed', err));

    void this.auditLogs
      .logAction({
        entity: 'REVIEW',
        action: 'REVIEW_CREATED',
        actorType: 'CUSTOMER',
        actorId: customerId,
        metadata: {
          reviewId: review.id,
          orderId: createReviewDto.orderId,
          rating: createReviewDto.rating,
        },
      })
      .catch(() => undefined);

    return review;
  }

  async findAllForAdmin() {
    const reviews = await this.prisma.review.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, name: true, email: true, avatar: true } },
        store: { select: { id: true, name: true, ownerId: true } },
        order: { select: { id: true, orderNumber: true } },
      },
    });

    return reviews.map(review => ({
      ...review,
      customerCode: `CUST-${review.customer.id.substring(0, 8).toUpperCase()}`
    }));
  }

  async updateStatus(adminId: string, id: string, updateDto: UpdateReviewStatusDto) {
    const review = await this.prisma.review.findUnique({ 
        where: { id },
        include: { store: true, order: true }
    });
    
    if (!review) {
      throw new NotFoundException('Review not found');
    }

    const updatedReview = await this.prisma.review.update({
      where: { id },
      data: { adminStatus: updateDto.status },
    });

    // Audit Log (2026 Review Moderation)
    await this.auditLogs.logAction({
        entity: 'REVIEW',
        action: 'REVIEW_MODERATED',
        actorType: 'ADMIN',
        actorId: adminId,
        metadata: { reviewId: id, status: updateDto.status, orderId: review.orderId }
    });

    // 5. Notify Merchant if Published
    if (updateDto.status === 'PUBLISHED') {
      await this.updateStoreRating(updatedReview.storeId);
      await this.merchantPerformance.recalculateAndPersist(updatedReview.storeId);

      // 6. Evaluate Rating Impact (2026 Standard: Automatic Rule Processing)
      await this.evaluateRatingImpact(updatedReview.storeId);

      await this.notifications.create({
        recipientId: review.store.ownerId,
        recipientRole: 'MERCHANT',
        titleAr: 'تقييم جديد رائع! ⭐',
        titleEn: 'New Great Review! ⭐',
        messageAr: `حصلت للتو على تقييم ${review.rating} نجوم للطلب ${review.order.orderNumber}.`,
        messageEn: `You just received a ${review.rating}-star review for order ${review.order.orderNumber}.`,
        type: 'alert',
        link: '/merchant/profile'
      });
    }

    return updatedReview;
  }

  async findByStore(storeId: string) {
    const reviews = await this.prisma.review.findMany({
      where: { storeId, adminStatus: 'PUBLISHED' },
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, name: true, avatar: true } },
      },
    });

    return reviews.map(review => ({
      ...review,
      customerCode: `CUST-${review.customer.id.substring(0, 8).toUpperCase()}`
    }));
  }

  async findAll() {
    const reviews = await this.prisma.review.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, name: true, avatar: true } },
      },
    });

    return reviews.map(review => ({
      ...review,
      customerCode: `CUST-${review.customer.id.substring(0, 8).toUpperCase()}`
    }));
  }

  async findAllForMerchant(ownerId: string) {
    const store = await this.prisma.store.findUnique({ where: { ownerId } });
    if (!store) throw new NotFoundException('Store not found');

    const reviews = await this.prisma.review.findMany({
      where: { storeId: store.id, adminStatus: 'PUBLISHED' }, // Strictly show only moderated reviews
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, name: true, avatar: true } },
        order: { select: { orderNumber: true } }
      },
    });

    return reviews.map(review => ({
      ...review,
      customerCode: `CUST-${review.customer.id.substring(0, 8).toUpperCase()}`
    }));
  }

  async getMerchantStats(ownerId: string) {
    const store = await this.prisma.store.findUnique({ 
        where: { ownerId },
        include: { _count: { select: { reviews: { where: { adminStatus: 'PUBLISHED' } } } } }
    });
    if (!store) throw new NotFoundException('Store not found');

    const reviews = await this.prisma.review.findMany({
      where: { storeId: store.id, adminStatus: 'PUBLISHED' }
    });

    const totalReviews = reviews.length;
    
    // 1. Customer Satisfaction (% of 4+ stars among published)
    const positiveReviews = reviews.filter(r => r.rating >= 4).length;
    const satisfaction = totalReviews > 0 ? (positiveReviews / totalReviews) * 100 : 0;

    // 2. Reputation Growth (Abstract score based on activity)
    const reputationGrowth = totalReviews > 0 ? (totalReviews * 0.5) + (Number(store.rating) * 2) : 0;

    // 3. Store Ranking (Competitive Logic)
    // We calculate a score and compare it with other stores
    const allStores = await this.prisma.store.findMany({
        select: { id: true, rating: true, lifetimeEarnings: true, _count: { select: { orders: true } } }
    });

    const calculateScore = (s: any) => 
        (Number(s.rating) * 7) + 
        (Number(s._count?.orders || 0) * 2) + 
        (Number(s.lifetimeEarnings || 0) * 0.001);

    const myScore = calculateScore(store);
    const higherRankedStores = allStores.filter(s => calculateScore(s) > myScore).length;
    
    const totalStores = allStores.length || 1;
    const percentile = 100 - ((higherRankedStores / totalStores) * 100);
    // Convert to "TOP X%"
    const topPercentage = Math.max(1, Math.round(100 - percentile));

    return {
      averageRating: Number(store.rating),
      totalReviews,
      publishedCount: totalReviews,
      satisfaction: Math.round(satisfaction),
      reputationGrowth: Number(reputationGrowth.toFixed(1)),
      storeRank: topPercentage,
    };
  }

  private async updateStoreRating(storeId: string) {
    const reviews = await this.prisma.review.findMany({
      where: { storeId, adminStatus: 'PUBLISHED' },
      select: { rating: true },
    });

    if (reviews.length === 0) return;

    const totalRating = reviews.reduce((acc, curr) => acc + curr.rating, 0);
    const averageRating = totalRating / reviews.length;

    await this.prisma.store.update({
      where: { id: storeId },
      data: { rating: averageRating },
    });
  }

  // --- RATING IMPACT RULES CRUD ---

  async getRatingImpactRules() {
    return this.prisma.ratingImpactRule.findMany({
      orderBy: { minRating: 'asc' },
    });
  }

  async createRatingImpactRule(dto: CreateRatingImpactRuleDto) {
    return this.prisma.ratingImpactRule.create({ data: dto });
  }

  async updateRatingImpactRule(id: string, dto: UpdateRatingImpactRuleDto) {
    return this.prisma.ratingImpactRule.update({
      where: { id },
      data: dto
    });
  }

  async deleteRatingImpactRule(id: string) {
    return this.prisma.ratingImpactRule.delete({ where: { id } });
  }

  /**
   * Evaluates the current average rating of a store against defined impact rules
   * and triggers the appropriate administrative actions.
   */
  async evaluateRatingImpact(storeId: string) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      include: { owner: true }
    });

    if (!store) return;

    const rating = Number(store.rating);
    
    // Find matching active rule
    const rule = await this.prisma.ratingImpactRule.findFirst({
      where: {
        isActive: true,
        minRating: { lte: rating },
        maxRating: { gte: rating }
      }
    });

    if (!rule || rule.actionType === 'NONE') return;

    if (rule.actionType === 'SUSPEND') {
      // 2026 Manual Governance: Create a PENDING penalty action for admin approval
      // We check if a pending suspension already exists to avoid duplicates
      const existingPenalty = await this.prisma.penaltyAction.findFirst({
        where: {
          targetStoreId: storeId,
          action: 'TEMPORARY_SUSPENSION',
          status: 'PENDING_APPROVAL'
        }
      });

      if (!existingPenalty) {
        await this.prisma.penaltyAction.create({
          data: {
            targetUserId: store.ownerId,
            targetStoreId: storeId,
            targetType: 'MERCHANT',
            action: 'TEMPORARY_SUSPENSION',
            status: 'PENDING_APPROVAL',
            adminNotes: `Automated Impact Trigger: Average Rating (${rating.toFixed(2)}) fell into suspension range (${rule.minRating}-${rule.maxRating}).`
          }
        });

        // Notify Admins
        await this.notifications.notifyAdmins({
          titleAr: 'مراجعة إيقاف متجر مطلوبة ⚠️',
          titleEn: 'Store Suspension Review Required ⚠️',
          messageAr: `متوسط تقييم المتجر "${store.name}" انخفض إلى ${rating.toFixed(2)}. تم إنشاء طلب إيقاف للمراجعة.`,
          messageEn: `Store "${store.name}" average rating fell to ${rating.toFixed(2)}. A suspension request has been created for review.`,
          type: 'alert'
        });
      }
    } else if (rule.actionType === 'WARNING') {
      // Send warning notification to merchant
      await this.notifications.create({
        recipientId: store.ownerId,
        recipientRole: 'MERCHANT',
        titleAr: 'تحذير بخصوص مستوى التقييم ⚠️',
        titleEn: 'Performance Warning: Rating Levels ⚠️',
        messageAr: `نود تنبيهك بأن متوسط تقييم متجرك حالياً هو ${rating.toFixed(2)}. يرجى العمل على تحسين جودة الخدمة لتجنب الإجراءات الإدارية.`,
        messageEn: `Please be advised that your store's average rating is currently ${rating.toFixed(2)}. Please improve service quality to avoid administrative actions.`,
        type: 'alert'
      });
    } else if (rule.actionType === 'FEATURED') {
      // Notify merchant of featured status
      await this.notifications.create({
        recipientId: store.ownerId,
        recipientRole: 'MERCHANT',
        titleAr: 'تهانينا! متجرك الآن مميز 🌟',
        titleEn: 'Congratulations! Your store is now Featured 🌟',
        messageAr: `بناءً على تقييمك الرائع (${rating.toFixed(2)})، حصل متجرك على وسم التاجر المميز في المنصة.`,
        messageEn: `Based on your excellent rating (${rating.toFixed(2)}), your store has earned the Featured Merchant badge.`,
        type: 'alert'
      });
    }
  }
}

