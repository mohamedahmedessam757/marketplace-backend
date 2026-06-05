import { describe, it, expect } from '@jest/globals';
import { OfferFulfillmentStatus, OrderStatus } from '../prisma/client';
import {
    aggregateMultiItemDeliveryStatus,
    isOfferReturnEligible,
} from './offer-resolution.helpers';

describe('per-offer resolution helpers', () => {
    it('returns eligible within 24h of delivery', () => {
        const deliveredAt = new Date('2026-05-30T12:00:00Z');
        const now = deliveredAt.getTime() + 2 * 60 * 60 * 1000;
        expect(
            isOfferReturnEligible({
                fulfillmentStatus: OfferFulfillmentStatus.DELIVERED,
                deliveredAt,
                resolutionLocked: false,
                now,
            }),
        ).toBe(true);
    });

    it('returns ineligible after 24h window', () => {
        const deliveredAt = new Date('2026-05-30T12:00:00Z');
        const now = deliveredAt.getTime() + 25 * 60 * 60 * 1000;
        expect(
            isOfferReturnEligible({
                fulfillmentStatus: OfferFulfillmentStatus.DELIVERED,
                deliveredAt,
                resolutionLocked: false,
                now,
            }),
        ).toBe(false);
    });

    it('aggregates PARTIALLY_DELIVERED when one of three offers delivered', () => {
        expect(
            aggregateMultiItemDeliveryStatus([
                OfferFulfillmentStatus.DELIVERED,
                OfferFulfillmentStatus.SHIPPED,
                OfferFulfillmentStatus.SHIPPED,
            ]),
        ).toBe(OrderStatus.PARTIALLY_DELIVERED);
    });

    it('aggregates COMPLETED when all offers completed', () => {
        expect(
            aggregateMultiItemDeliveryStatus([
                OfferFulfillmentStatus.COMPLETED,
                OfferFulfillmentStatus.COMPLETED,
            ]),
        ).toBe(OrderStatus.COMPLETED);
    });
});
