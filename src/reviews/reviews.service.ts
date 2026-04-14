import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { UpdateReviewStatusDto } from './dto/update-review-status.dto';

@Injectable()
export class ReviewsService {
  constructor(private prisma: PrismaService) {}

  async create(customerId: string, createReviewDto: CreateReviewDto) {
    // 1. Validate Order belongs to Customer and is in CLOSED state
    const order = await this.prisma.order.findUnique({
      where: { id: createReviewDto.orderId },
      include: { customer: true }
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }
    
    if (order.customerId !== customerId) {
      throw new BadRequestException('You do not have permission to review this order');
    }

    if (order.status !== 'CLOSED' && order.status !== 'DELIVERED' && order.status !== 'COMPLETED') {
        throw new BadRequestException('Order must be delivered or closed to be reviewed');
    }

    // 2. Prevent duplicate reviews
    const existingReview = await this.prisma.review.findUnique({
      where: { orderId: createReviewDto.orderId },
    });

    if (existingReview) {
      throw new BadRequestException('You have already reviewed this order');
    }

    // 3. Create the review as PENDING
    const review = await this.prisma.review.create({
      data: {
        orderId: createReviewDto.orderId,
        customerId,
        storeId: createReviewDto.storeId,
        rating: createReviewDto.rating,
        comment: createReviewDto.comment,
        adminStatus: 'PENDING',
      },
    });

    // 4. Notify Super Admins
    const admins = await this.prisma.user.findMany({ where: { role: 'SUPER_ADMIN' } });
    for (const admin of admins) {
      await this.prisma.notification.create({
        data: {
          recipientId: admin.id,
          recipientRole: 'ADMIN',
          titleAr: 'تقييم جديد للمراجعة',
          titleEn: 'New Review for Moderation',
          messageAr: `قام العميل بوضع تقييم للطلب ${order.orderNumber}. بانتظار موافقتك.`,
          messageEn: `A customer has left a review on order ${order.orderNumber}. Awaiting your approval.`,
          type: 'alert',
          metadata: { reviewId: review.id }
        }
      });
    }

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

  async updateStatus(id: string, updateDto: UpdateReviewStatusDto) {
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

    // 5. Notify Merchant if Published
    if (updateDto.status === 'PUBLISHED') {
      await this.updateStoreRating(updatedReview.storeId);
      
      await this.prisma.notification.create({
        data: {
          recipientId: review.store.ownerId,
          recipientRole: 'MERCHANT',
          titleAr: 'تقييم جديد رائع! ⭐',
          titleEn: 'New Great Review! ⭐',
          messageAr: `حصلت للتو على تقييم ${review.rating} نجوم للطلب ${review.order.orderNumber}.`,
          messageEn: `You just received a ${review.rating}-star review for order ${review.order.orderNumber}.`,
          type: 'alert',
          link: '/merchant/profile'
        }
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
}
