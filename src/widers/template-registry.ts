import type {
    WidersAudience,
    WidersTemplateCategory,
    WidersTemplateLanguage,
} from './widers.types';

/** Semantic keys sent by WhatsAppChannelService — mapped to {{1}}…{{n}} in order */
export type TemplateBodyField =
    | 'name'
    | 'otp_code'
    | 'order_number'
    | 'status_detail'
    | 'tracking_number'
    | 'invoice_number'
    | 'amount'
    | 'summary'
    | 'store_name'
    | 'doc_type';

export interface TemplateDefinition {
    name: string;
    language: WidersTemplateLanguage;
    category: WidersTemplateCategory;
    audience: WidersAudience;
    headerText?: string;
    bodyFields: TemplateBodyField[];
    buttonLabel?: string;
    /** Path after `/dashboard/` — may include `{orderId}`, `{offerId}` placeholders */
    buttonSuffixPattern?: string;
}

const suffix = {
    orderCustomer: 'order-details/{orderId}',
    orderMerchant: 'explore-offer/{orderId}',
    invoiceCustomer: 'order-details/{orderId}?tab=invoices&offerId={offerId}',
    invoiceMerchant: 'explore-offer/{orderId}?tab=invoices&offerId={offerId}',
    waybillCustomer: 'order-details/{orderId}?tab=waybills',
    waybillMerchant: 'explore-offer/{orderId}?tab=waybills',
    storeHome: 'home',
} as const;

function def(
    baseName: string,
    language: WidersTemplateLanguage,
    audience: WidersAudience,
    bodyFields: TemplateBodyField[],
    opts: Partial<Omit<TemplateDefinition, 'name' | 'language' | 'audience' | 'bodyFields'>> = {},
): TemplateDefinition {
    return {
        name: `${baseName}_${language}`,
        language,
        audience,
        category: opts.category ?? 'UTILITY',
        bodyFields,
        ...opts,
    };
}

/** Mirrors Widers Dashboard templates — single source of truth for dispatch */
export const TEMPLATE_REGISTRY: TemplateDefinition[] = [
    // OTP — utility fallback until Meta Authentication is enabled on WABA
    def('auth_otp_customer', 'ar', 'customer', ['name', 'otp_code'], {
        category: 'UTILITY',
        headerText: 'رمز التحقق',
    }),
    def('auth_otp_vendor', 'ar', 'vendor', ['name', 'otp_code'], {
        category: 'UTILITY',
        headerText: 'رمز التحقق',
    }),

    // Orders
    def('txn_order_customer', 'ar', 'customer', ['name', 'order_number', 'status_detail'], {
        headerText: 'تحديث طلب',
        buttonLabel: 'عرض الطلب',
        buttonSuffixPattern: suffix.orderCustomer,
    }),
    def('txn_order_merchant', 'ar', 'merchant', ['name', 'order_number', 'status_detail'], {
        headerText: 'تحديث طلب',
        buttonLabel: 'فتح الطلب',
        buttonSuffixPattern: suffix.orderMerchant,
    }),

    // Shipments
    def('txn_shipment_customer', 'ar', 'customer', [
        'name',
        'order_number',
        'status_detail',
        'tracking_number',
    ], {
        headerText: 'تحديث الشحن',
        buttonLabel: 'تتبع الشحنة',
        buttonSuffixPattern: suffix.orderCustomer,
    }),
    def('txn_shipment_merchant', 'ar', 'merchant', [
        'name',
        'order_number',
        'status_detail',
        'tracking_number',
    ], {
        headerText: 'تحديث شحن الطلب',
        buttonLabel: 'فتح الطلب',
        buttonSuffixPattern: suffix.orderMerchant,
    }),

    // Invoices (per offer)
    def('txn_invoice_customer', 'ar', 'customer', [
        'name',
        'order_number',
        'invoice_number',
        'amount',
        'summary',
    ], {
        headerText: 'فاتورة جاهزة',
        buttonLabel: 'عرض الفاتورة',
        buttonSuffixPattern: suffix.invoiceCustomer,
    }),
    def('txn_invoice_merchant', 'ar', 'merchant', [
        'name',
        'order_number',
        'invoice_number',
        'amount',
        'summary',
    ], {
        headerText: 'فاتورة جديدة',
        buttonLabel: 'عرض الفاتورة',
        buttonSuffixPattern: suffix.invoiceMerchant,
    }),

    // Waybills
    def('txn_waybill_customer', 'ar', 'customer', ['name', 'order_number', 'status_detail'], {
        headerText: 'بوليصة الشحن',
        buttonLabel: 'عرض البوليصة',
        buttonSuffixPattern: suffix.waybillCustomer,
    }),
    def('txn_waybill_merchant', 'ar', 'merchant', ['name', 'order_number', 'status_detail'], {
        headerText: 'بوليصة الشحن',
        buttonLabel: 'عرض البوليصة',
        buttonSuffixPattern: suffix.waybillMerchant,
    }),

    // Store documents (vendor only)
    def('txn_document_vendor', 'ar', 'vendor', ['store_name', 'doc_type', 'status_detail'], {
        headerText: 'مستندات المتجر',
        buttonLabel: 'فتح لوحة المتجر',
        buttonSuffixPattern: suffix.storeHome,
    }),

    // Part verification
    def('txn_verification_customer', 'ar', 'customer', ['name', 'order_number', 'status_detail'], {
        headerText: 'توثيق الطلب',
        buttonLabel: 'عرض الطلب',
        buttonSuffixPattern: suffix.orderCustomer,
    }),
    def('txn_verification_vendor', 'ar', 'merchant', ['name', 'order_number', 'status_detail'], {
        headerText: 'توثيق الطلب',
        buttonLabel: 'فتح الطلب',
        buttonSuffixPattern: suffix.orderMerchant,
    }),

    // Optional marketing (created in Widers — not wired in Phase 5 initially)
    def('welcome_customer', 'ar', 'customer', ['name'], {
        category: 'MARKETING',
        buttonLabel: 'ابدأ الآن',
        buttonSuffixPattern: suffix.storeHome,
    }),
    def('welcome_vendor', 'ar', 'vendor', ['name'], {
        category: 'MARKETING',
        buttonLabel: 'ابدأ الآن',
        buttonSuffixPattern: suffix.storeHome,
    }),
];

const registryByName = new Map(
    TEMPLATE_REGISTRY.map((t) => [t.name, t]),
);

export function getTemplateDefinition(name: string): TemplateDefinition | undefined {
    return registryByName.get(name);
}

export function resolveTemplateName(
    familyBase: string,
    language: WidersTemplateLanguage,
): string {
    return `${familyBase}_${language}`;
}

/** Meta/WhatsApp per-variable body limit (safe default) */
export const WHATSAPP_BODY_PARAM_MAX = 1024;

export function truncateWhatsAppParam(value: string, max = WHATSAPP_BODY_PARAM_MAX): string {
    const trimmed = value.trim();
    if (trimmed.length <= max) return trimmed;
    return `${trimmed.slice(0, max - 1)}…`;
}

export function buildButtonSuffix(
    pattern: string,
    vars: { orderId?: string; offerId?: string },
): string {
    return pattern
        .replace('{orderId}', vars.orderId ?? '')
        .replace('{offerId}', vars.offerId ?? '');
}
