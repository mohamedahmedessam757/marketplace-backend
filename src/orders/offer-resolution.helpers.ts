import { OfferFulfillmentStatus, OrderStatus } from '@prisma/client';
import { POST_DELIVERY_RETURN_DISPUTE_HOURS } from './order-time.constants';

export function getOfferReturnWindowEndsAt(deliveredAt: Date): Date {
    const windowMs = POST_DELIVERY_RETURN_DISPUTE_HOURS * 60 * 60 * 1000;
    return new Date(deliveredAt.getTime() + windowMs);
}

export function isOfferReturnEligible(input: {
    fulfillmentStatus: OfferFulfillmentStatus;
    deliveredAt: Date | null;
    resolutionLocked: boolean;
    now?: number;
}): boolean {
    if (input.resolutionLocked) return false;
    if (input.fulfillmentStatus === OfferFulfillmentStatus.COMPLETED) return false;
    if (input.fulfillmentStatus !== OfferFulfillmentStatus.DELIVERED) return false;
    if (!input.deliveredAt) return false;
    const endsAt = getOfferReturnWindowEndsAt(input.deliveredAt);
    const now = input.now ?? Date.now();
    return now <= endsAt.getTime();
}

export function aggregateMultiItemDeliveryStatus(
    statuses: OfferFulfillmentStatus[],
): OrderStatus {
    if (statuses.length === 0) return OrderStatus.SHIPPED;
    const allShippedOrBeyond = statuses.every(
        (s) =>
            s === OfferFulfillmentStatus.SHIPPED ||
            s === OfferFulfillmentStatus.DELIVERED ||
            s === OfferFulfillmentStatus.COMPLETED,
    );
    if (!allShippedOrBeyond) return OrderStatus.PARTIALLY_SHIPPED;

    const completed = statuses.every((s) => s === OfferFulfillmentStatus.COMPLETED);
    if (completed) return OrderStatus.COMPLETED;

    const deliveredCount = statuses.filter(
        (s) =>
            s === OfferFulfillmentStatus.DELIVERED ||
            s === OfferFulfillmentStatus.COMPLETED,
    ).length;
    if (deliveredCount > 0 && deliveredCount < statuses.length) {
        return OrderStatus.PARTIALLY_DELIVERED;
    }
    if (deliveredCount === statuses.length) return OrderStatus.DELIVERED;
    return OrderStatus.SHIPPED;
}
