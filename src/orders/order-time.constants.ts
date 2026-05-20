/**
 * Post-delivery window (hours): return requests, disputes, and auto-transition to COMPLETED.
 * Must stay aligned with Frontend countdown and scheduled jobs.
 */
export const POST_DELIVERY_RETURN_DISPUTE_HOURS = 24;

export const postDeliveryReturnDisputeMs = (): number =>
    POST_DELIVERY_RETURN_DISPUTE_HOURS * 60 * 60 * 1000;
