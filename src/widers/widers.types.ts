export type WidersTemplateLanguage = 'ar' | 'en';

export type WidersAudience = 'customer' | 'merchant' | 'vendor';

export type WidersTemplateCategory = 'UTILITY' | 'AUTHENTICATION' | 'MARKETING';

export type WidersOtpMode = 'authentication' | 'utility';

export interface WidersTextParameter {
    type: 'text';
    text: string;
}

export interface WidersTemplateComponent {
    type: 'header' | 'body' | 'button';
    sub_type?: 'url' | 'quick_reply' | 'otp';
    index?: string;
    parameters: WidersTextParameter[];
}

export interface SendTemplateMessagePayload {
    phone: string;
    templateName: string;
    templateLanguage: WidersTemplateLanguage;
    components?: WidersTemplateComponent[];
}

export interface MakeContactPayload {
    phone: string;
    name?: string;
    email?: string;
    groups?: string;
    tags?: string;
    fields?: Record<string, string>;
}

export interface WidersApiResponse<T = unknown> {
    success?: boolean;
    message?: string;
    data?: T;
    error?: string;
}

export interface WidersHealthStatus {
    enabled: boolean;
    configured: boolean;
    apiReachable: boolean;
    frontendUrl: string | null;
    otpMode: WidersOtpMode;
    templateCount?: number;
    message?: string;
}

