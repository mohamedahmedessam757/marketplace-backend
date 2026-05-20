/**
 * Single source of truth for admin adjudication financial rules (disputes / returns).
 */

export type AdjudicationFaultParty =
    | 'CUSTOMER'
    | 'MERCHANT'
    | 'STORE'
    | 'VENDOR'
    | 'SHIPPING_COMPANY'
    | 'CLOSE_COMPLETE_REFUND'
    | string;

export type FeeBearer = 'CUSTOMER' | 'MERCHANT' | 'PLATFORM' | 'MIXED_CLOSE';
export type ShippingBearer = 'CUSTOMER' | 'MERCHANT' | 'SHIPPING_COMPANY' | 'NONE';

export interface AdjudicationFinancialInput {
    orderPaidTotal: number;
    gatewayFeePct: number;
    refundFeePct: number;
    shippingRoundtrip: number;
    faultParty: AdjudicationFaultParty;
    maxRefundable?: number;
    /** Client preview only — server may override on mismatch */
    calculatedNetRefund?: number;
}

export interface AdjudicationFinancialResult {
    gatewayFeeAmount: number;
    refundFeeAmount: number;
    platformFeesTotal: number;
    /** Amount sent to Stripe (customer refund) */
    customerStripeRefund: number;
    /** @deprecated alias */
    stripeRefundAmount: number;
    netRefundAmount: number;
    platformRetainedAmount: number;
    feeBearer: FeeBearer;
    shippingBearer: ShippingBearer;
    merchantWalletDebits: { shipping: number; platformFees: number };
    shippingCompanyLiability: number;
    stripeCapped: boolean;
    refundCappedFrom?: number;
    gatewayFeePct: number;
    refundFeePct: number;
}

function normalizeFault(faultParty: AdjudicationFaultParty): string {
    return String(faultParty || 'MERCHANT').toUpperCase();
}

function isMerchantFault(fault: string): boolean {
    return ['STORE', 'MERCHANT', 'VENDOR'].includes(fault);
}

export function computeAdjudicationFinancials(
    input: AdjudicationFinancialInput,
): AdjudicationFinancialResult {
    const orderPaidTotal = Math.max(0, Number(input.orderPaidTotal) || 0);
    const gatewayFeePct = Number(input.gatewayFeePct ?? 3);
    const refundFeePct = Number(input.refundFeePct ?? 1.5);
    const shippingRoundtrip = Math.max(0, Number(input.shippingRoundtrip) || 0);
    const fault = normalizeFault(input.faultParty);
    const isCloseComplete = fault === 'CLOSE_COMPLETE_REFUND';

    const gatewayFeeAmount = (orderPaidTotal * gatewayFeePct) / 100;
    const refundFeeAmount = (orderPaidTotal * refundFeePct) / 100;
    const platformFeesTotal = gatewayFeeAmount + refundFeeAmount;

    let feeBearer: FeeBearer = 'CUSTOMER';
    let shippingBearer: ShippingBearer = 'NONE';
    let customerStripeRefund = 0;
    let platformRetainedAmount = 0;
    let merchantShippingDebit = 0;
    let merchantPlatformFeesDebit = 0;
    let shippingCompanyLiability = 0;

    if (isCloseComplete) {
        feeBearer = 'MIXED_CLOSE';
        shippingBearer = 'NONE';
        platformRetainedAmount = platformFeesTotal;
        customerStripeRefund = Math.max(0, orderPaidTotal - platformFeesTotal);
        if (input.calculatedNetRefund != null) {
            const fromClient = Math.max(0, Number(input.calculatedNetRefund));
            if (
                Math.abs(fromClient - customerStripeRefund) > 0.01 &&
                fromClient <= platformFeesTotal + 0.01
            ) {
                customerStripeRefund = Math.max(0, orderPaidTotal - platformFeesTotal);
            } else if (fromClient < orderPaidTotal - platformFeesTotal + 0.01) {
                customerStripeRefund = fromClient;
            }
        }
    } else if (isMerchantFault(fault)) {
        feeBearer = 'MERCHANT';
        shippingBearer = shippingRoundtrip > 0 ? 'MERCHANT' : 'NONE';
        customerStripeRefund = orderPaidTotal;
        merchantShippingDebit = shippingRoundtrip;
        merchantPlatformFeesDebit = platformFeesTotal;
        platformRetainedAmount = platformFeesTotal;
    } else if (fault === 'SHIPPING_COMPANY') {
        feeBearer = 'PLATFORM';
        shippingBearer = shippingRoundtrip > 0 ? 'SHIPPING_COMPANY' : 'NONE';
        customerStripeRefund = orderPaidTotal;
        shippingCompanyLiability = shippingRoundtrip;
        platformRetainedAmount = 0;
    } else {
        // CUSTOMER (default guilty party for claims)
        feeBearer = 'CUSTOMER';
        shippingBearer = shippingRoundtrip > 0 ? 'CUSTOMER' : 'NONE';
        platformRetainedAmount = platformFeesTotal;
        customerStripeRefund = Math.max(
            0,
            orderPaidTotal - platformFeesTotal - shippingRoundtrip,
        );
    }

    const netRefundAmount = customerStripeRefund;

    let stripeCapped = false;
    let refundCappedFrom: number | undefined;
    const maxRefundable =
        input.maxRefundable != null && input.maxRefundable >= 0
            ? input.maxRefundable
            : undefined;

    let cappedStripe = customerStripeRefund;
    if (maxRefundable != null && cappedStripe > maxRefundable) {
        stripeCapped = true;
        refundCappedFrom = cappedStripe;
        cappedStripe = maxRefundable;
    }

    return {
        gatewayFeeAmount,
        refundFeeAmount,
        platformFeesTotal,
        customerStripeRefund: cappedStripe,
        stripeRefundAmount: cappedStripe,
        netRefundAmount,
        platformRetainedAmount,
        feeBearer,
        shippingBearer,
        merchantWalletDebits: {
            shipping: merchantShippingDebit,
            platformFees: merchantPlatformFeesDebit,
        },
        shippingCompanyLiability,
        stripeCapped,
        refundCappedFrom,
        gatewayFeePct,
        refundFeePct,
    };
}
