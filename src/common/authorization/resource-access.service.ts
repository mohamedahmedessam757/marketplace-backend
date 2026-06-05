import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { isAdminRole } from '../user-sanitizer';

export interface AuthActor {
  id: string;
  role: string;
  storeId?: string | null;
}

@Injectable()
export class ResourceAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async assertUserCanAccessOrder(actor: AuthActor, orderId: string): Promise<void> {
    if (isAdminRole(actor.role)) return;

    if (!this.isUuid(orderId)) {
      throw new BadRequestException('Invalid order ID');
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { customerId: true, storeId: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    if (actor.role === 'CUSTOMER' && order.customerId === actor.id) return;

    if (actor.role === 'VENDOR' && actor.storeId && order.storeId === actor.storeId) return;

    if (actor.role === 'VENDOR' && actor.storeId) {
      const vendorOffer = await this.prisma.offer.findFirst({
        where: { orderId, storeId: actor.storeId },
        select: { id: true },
      });
      if (vendorOffer) return;
    }

    throw new ForbiddenException('Access denied to this order');
  }

  async assertUserCanAccessChat(actor: AuthActor, chatId: string): Promise<void> {
    const chat = await this.prisma.orderChat.findUnique({
      where: { id: chatId },
      include: { vendor: { select: { ownerId: true } } },
    });
    if (!chat) throw new NotFoundException('Chat not found');

    if (isAdminRole(actor.role)) return;
    if (chat.customerId === actor.id) return;
    if (chat.vendor?.ownerId === actor.id) return;

    throw new ForbiddenException('Access denied to this chat');
  }

  async assertUserCanAccessInvoice(actor: AuthActor, orderId: string): Promise<void> {
    await this.assertUserCanAccessOrder(actor, orderId);
  }

  async assertUserCanAccessWaybill(actor: AuthActor, waybillId: string): Promise<void> {
    const waybill = await (this.prisma as any).shippingWaybill.findUnique({
      where: { id: waybillId },
      select: { orderId: true },
    });
    if (!waybill) throw new NotFoundException('Waybill not found');
    await this.assertUserCanAccessOrder(actor, waybill.orderId);
  }

  async assertUserCanAccessViolation(actor: AuthActor, violationId: string): Promise<void> {
    if (isAdminRole(actor.role)) return;

    const violation = await this.prisma.violation.findUnique({
      where: { id: violationId },
      select: {
        targetUserId: true,
        targetStore: { select: { ownerId: true } },
      },
    });
    if (!violation) throw new NotFoundException('Violation not found');

    if (violation.targetUserId === actor.id) return;
    if (violation.targetStore?.ownerId === actor.id) return;

    throw new ForbiddenException('Access denied to this violation');
  }

  async assertUserCanViewUserProfile(actor: AuthActor, targetUserId: string): Promise<void> {
    if (actor.id === targetUserId) return;
    if (isAdminRole(actor.role)) return;
    throw new ForbiddenException('Access denied to this user profile');
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.trim(),
    );
  }
}
