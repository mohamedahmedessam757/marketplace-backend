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
    return this.prisma.review.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, name: true, email: true } },
        store: { select: { id: true, name: true, ownerId: true } },
        order: { select: { id: true, orderNumber: true } },
      },
    });
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
    return this.prisma.review.findMany({
      where: { storeId, adminStatus: 'PUBLISHED' },
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { name: true, avatar: true } },
      },
    });
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
