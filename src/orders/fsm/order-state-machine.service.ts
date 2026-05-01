import { Injectable, BadRequestException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';

@Injectable()
export class OrderStateMachine {
    // TRANSITION_RULES matching Frontend useOrderStore.ts EXACTLY
    private readonly TRANSITION_RULES: Record<OrderStatus, OrderStatus[]> = {
        [OrderStatus.COLLECTING_OFFERS]: [OrderStatus.AWAITING_SELECTION, OrderStatus.CANCELLED],
        [OrderStatus.AWAITING_SELECTION]: [OrderStatus.AWAITING_PAYMENT, OrderStatus.CANCELLED],
        [OrderStatus.AWAITING_OFFERS]: [OrderStatus.AWAITING_PAYMENT, OrderStatus.CANCELLED],
        [OrderStatus.AWAITING_PAYMENT]: [OrderStatus.PREPARATION, OrderStatus.CANCELLED],
        [OrderStatus.PREPARATION]: [OrderStatus.PREPARED, OrderStatus.DELAYED_PREPARATION, OrderStatus.CANCELLED], 
        [OrderStatus.PREPARED]: [OrderStatus.VERIFICATION, OrderStatus.CANCELLED],
        [OrderStatus.VERIFICATION]: [OrderStatus.VERIFICATION_SUCCESS, OrderStatus.NON_MATCHING, OrderStatus.CANCELLED],
        [OrderStatus.VERIFICATION_SUCCESS]: [OrderStatus.READY_FOR_SHIPPING, OrderStatus.CANCELLED],
        [OrderStatus.READY_FOR_SHIPPING]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
        [OrderStatus.NON_MATCHING]: [OrderStatus.CORRECTION_PERIOD, OrderStatus.CANCELLED],
        [OrderStatus.CORRECTION_PERIOD]: [OrderStatus.CORRECTION_SUBMITTED, OrderStatus.CANCELLED],
        [OrderStatus.CORRECTION_SUBMITTED]: [OrderStatus.VERIFICATION_SUCCESS, OrderStatus.NON_MATCHING, OrderStatus.CANCELLED],
        [OrderStatus.DELAYED_PREPARATION]: [OrderStatus.PREPARED, OrderStatus.CANCELLED],
        [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED, OrderStatus.RETURNED, OrderStatus.DISPUTED],
        [OrderStatus.DELIVERED]: [OrderStatus.COMPLETED, OrderStatus.WARRANTY_ACTIVE, OrderStatus.CLOSED, OrderStatus.RETURNED, OrderStatus.DISPUTED],
        [OrderStatus.WARRANTY_ACTIVE]: [OrderStatus.WARRANTY_EXPIRED, OrderStatus.RETURNED, OrderStatus.DISPUTED, OrderStatus.CLOSED],
        [OrderStatus.WARRANTY_EXPIRED]: [OrderStatus.COMPLETED, OrderStatus.CLOSED],
        [OrderStatus.COMPLETED]: [OrderStatus.WARRANTY_ACTIVE, OrderStatus.CLOSED],
        [OrderStatus.CLOSED]: [],
        [OrderStatus.CANCELLED]: [],
        [OrderStatus.RETURNED]: [OrderStatus.COMPLETED, OrderStatus.WARRANTY_ACTIVE, OrderStatus.CLOSED],
        [OrderStatus.DISPUTED]: [OrderStatus.COMPLETED, OrderStatus.WARRANTY_ACTIVE, OrderStatus.CLOSED, OrderStatus.RETURNED, OrderStatus.REFUNDED],
        [OrderStatus.REFUNDED]: [],
        [OrderStatus.RETURN_REQUESTED]: [OrderStatus.RETURN_APPROVED, OrderStatus.DISPUTED],
        [OrderStatus.RETURN_APPROVED]: [OrderStatus.RETURNED],
        [OrderStatus.RESOLVED]: [OrderStatus.COMPLETED, OrderStatus.WARRANTY_ACTIVE, OrderStatus.CLOSED],
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
