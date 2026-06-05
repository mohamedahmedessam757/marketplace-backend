export type WhatsAppAudienceRole = 'CUSTOMER' | 'MERCHANT';

export interface NotificationDispatchInput {
    recipientRole: string;
    type?: string;
    titleAr: string;
    titleEn: string;
    messageAr: string;
    messageEn: string;
    link?: string;
    metadata?: Record<string, unknown> | null;
}

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeWhatsAppRole(role: string): WhatsAppAudienceRole | null {
    const upper = role.toUpperCase();
    if (upper === 'CUSTOMER') return 'CUSTOMER';
    if (upper === 'MERCHANT' || upper === 'VENDOR') return 'MERCHANT';
    return null;
}

export function isWhatsAppEligibleRole(role: string): boolean {
    return normalizeWhatsAppRole(role) !== null;
}

export function extractOrderId(
    metadata?: Record<string, unknown> | null,
    link?: string,
): string | null {
    const fromMeta = metadata?.orderId;
    if (typeof fromMeta === 'string' && UUID_RE.test(fromMeta)) {
        return fromMeta;
    }
    if (!link) return null;
    const match = link.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    );
    return match?.[0] ?? null;
}

export function extractOfferId(metadata?: Record<string, unknown> | null): string | null {
    const raw = metadata?.offerId;
    if (typeof raw === 'string' && UUID_RE.test(raw)) {
        return raw;
    }
    return null;
}

function containsAny(haystack: string, needles: string[]): boolean {
    const lower = haystack.toLowerCase();
    return needles.some((n) => lower.includes(n.toLowerCase()));
}

function isWaybillNotification(input: NotificationDispatchInput): boolean {
    const blob = `${input.titleAr} ${input.titleEn} ${input.messageAr} ${input.messageEn}`;
    return containsAny(blob, ['بوليصة', 'waybill', 'return label', 'بوليصة الإرجاع']);
}

function isDocumentNotification(input: NotificationDispatchInput, role: WhatsAppAudienceRole): boolean {
    if (role !== 'MERCHANT') return false;
    const type = (input.type ?? '').toUpperCase();
    if (['DOC_EXPIRY', 'SUCCESS'].includes(type)) return true;
    if (input.metadata?.docType) return true;
    const blob = `${input.titleAr} ${input.titleEn} ${input.messageAr} ${input.messageEn}`;
    return containsAny(blob, ['مستند', 'document', 'doc_type', 'إعادة رفع']);
}

function isVerificationNotification(input: NotificationDispatchInput): boolean {
    const type = (input.type ?? '').toLowerCase();
    if (input.metadata?.verification === true) return true;
    const blob = `${input.titleAr} ${input.titleEn} ${input.messageAr} ${input.messageEn}`;
    return (
        type === 'system_alert' &&
        containsAny(blob, [
            'توثيق',
            'verification',
            'مطابقة',
            'non-match',
            'non matching',
            'عدم المطابقة',
        ])
    );
}

function isPaymentFailure(input: NotificationDispatchInput): boolean {
    if (input.metadata?.failureReason) return true;
    const blob = `${input.titleAr} ${input.titleEn}`;
    return containsAny(blob, ['فشل', 'failed', 'failure']);
}

/**
 * Maps in-app notification → Widers template family base (without _ar/_en suffix).
 */
export function resolveTemplateFamily(
    input: NotificationDispatchInput,
    role: WhatsAppAudienceRole,
    opts?: { hasInvoice?: boolean },
): string | null {
    const type = (input.type ?? '').toUpperCase();

    if (['REFERRAL', 'CHAT', 'FINANCIAL', 'WALLET', 'SYSTEM'].includes(type)) {
        return null;
    }

    if (isDocumentNotification(input, role)) {
        return 'txn_document_vendor';
    }

    if (type === 'SHIPMENT_UPDATE') {
        return role === 'CUSTOMER' ? 'txn_shipment_customer' : 'txn_shipment_merchant';
    }

    if (type === 'PAYMENT' || type === 'payment') {
        if (isPaymentFailure(input)) return null;
        if (opts?.hasInvoice) {
            return role === 'CUSTOMER' ? 'txn_invoice_customer' : 'txn_invoice_merchant';
        }
        return role === 'CUSTOMER' ? 'txn_order_customer' : 'txn_order_merchant';
    }

    if (type === 'ORDER_UPDATE' || type === 'order_update') {
        if (isWaybillNotification(input)) {
            return role === 'CUSTOMER' ? 'txn_waybill_customer' : 'txn_waybill_merchant';
        }
        if (isVerificationNotification(input)) {
            return role === 'CUSTOMER'
                ? 'txn_verification_customer'
                : 'txn_verification_merchant';
        }
        return role === 'CUSTOMER' ? 'txn_order_customer' : 'txn_order_merchant';
    }

    if (type === 'ORDER' || type === 'SYSTEM_ALERT' || type === 'system_alert') {
        if (isVerificationNotification(input)) {
            return role === 'CUSTOMER'
                ? 'txn_verification_customer'
                : 'txn_verification_merchant';
        }
        if (['ORDER', 'SYSTEM_ALERT', 'system_alert'].includes(type)) {
            return role === 'CUSTOMER' ? 'txn_order_customer' : 'txn_order_merchant';
        }
    }

    if (['ALERT', 'SECURITY'].includes(type)) {
        return null;
    }

    return null;
}
