import { Injectable, BadRequestException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';

@Injectable()
export class OrderStateMachine {
    // TRANSITION_RULES matching Frontend useOrderStore.ts EXACTLY
    private readonly TRANSITION_RULES: Record<OrderStatus, OrderStatus[]> = {
        [OrderStatus.AWAITING_OFFERS]: [OrderStatus.AWAITING_PAYMENT, OrderStatus.CANCELLED],
        [OrderStatus.AWAITING_PAYMENT]: [OrderStatus.PREPARATION, OrderStatus.CANCELLED],
        [OrderStatus.PREPARATION]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
        [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED, OrderStatus.RETURNED, OrderStatus.DISPUTED],
        [OrderStatus.DELIVERED]: [OrderStatus.COMPLETED, OrderStatus.RETURNED, OrderStatus.DISPUTED],
        [OrderStatus.COMPLETED]: [],
        [OrderStatus.CANCELLED]: [],
        [OrderStatus.RETURNED]: [OrderStatus.COMPLETED],
        [OrderStatus.DISPUTED]: [OrderStatus.COMPLETED, OrderStatus.RETURNED, OrderStatus.REFUNDED], // Expanded
        [OrderStatus.REFUNDED]: [],
        [OrderStatus.RETURN_REQUESTED]: [OrderStatus.RETURN_APPROVED, OrderStatus.DISPUTED],
        [OrderStatus.RETURN_APPROVED]: [OrderStatus.RETURNED],
        [OrderStatus.RESOLVED]: [OrderStatus.COMPLETED],
    };

    validateTransition(currentStatus: OrderStatus, newStatus: OrderStatus): void {
        const allowedTransitions = this.TRANSITION_RULES[currentStatus] || [];

        if (!allowedTransitions.includes(newStatus)) {
            throw new BadRequestException(
                `Illegal transition: Cannot go from ${currentStatus} to ${newStatus}. Allowed: [${allowedTransitions.join(', ')}]`,
            );
        }
    }

    getAllowedTransitions(currentStatus: OrderStatus): OrderStatus[] {
        return this.TRANSITION_RULES[currentStatus] || [];
    }
}
