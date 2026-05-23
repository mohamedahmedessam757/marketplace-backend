/**
 * Server-side offer governance timing (source of truth for voluntary withdrawal windows).
 */

export interface OrderTimingContext {
  revealOffersAt: Date | null;
  createdAt: Date;
}

const REVEAL_OFFSET_MS = 24 * 60 * 60 * 1000;
const VOLUNTARY_END_BEFORE_REVEAL_MS = 60 * 60 * 1000;

export function getRevealAt(order: OrderTimingContext): Date {
  if (order.revealOffersAt) {
    return new Date(order.revealOffersAt);
  }
  return new Date(order.createdAt.getTime() + REVEAL_OFFSET_MS);
}

export function getVoluntaryWithdrawEnd(order: OrderTimingContext): Date {
  return new Date(getRevealAt(order).getTime() - VOLUNTARY_END_BEFORE_REVEAL_MS);
}
