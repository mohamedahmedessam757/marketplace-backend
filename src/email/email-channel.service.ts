import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import { EmailConfig } from './email.config';
import { buildOtpEmail, type OtpEmailLanguage } from './templates/otp-email.template';
import type { OtpPurpose } from '../auth/otp-purpose';

const PURPOSE_LABELS: Partial<Record<OtpPurpose, { ar: string; en: string }>> = {
    REGISTER: { ar: 'تفعيل الحساب', en: 'Account activation' },
    LOGIN: { ar: 'تسجيل الدخول', en: 'Sign in' },
    RECOVERY_STEP1: { ar: 'استرداد الحساب', en: 'Account recovery' },
    RECOVERY_PHONE: { ar: 'تأكيد رقم الجوال', en: 'Phone verification' },
};

@Injectable()
export class EmailChannelService {
    private readonly logger = new Logger(EmailChannelService.name);
    private readonly client: Resend | null;

    constructor(private readonly config: EmailConfig) {
        this.client = this.config.apiKey ? new Resend(this.config.apiKey) : null;
    }

    async sendOtp(params: {
        to: string;
        name: string;
        otpCode: string;
        language?: OtpEmailLanguage;
        purpose?: OtpPurpose;
    }): Promise<{ sent: boolean; error?: string }> {
        if (!this.config.enabled || !this.client) {
            return { sent: false, error: 'Email delivery disabled' };
        }

        const lang = params.language ?? 'ar';
        const labels = params.purpose ? PURPOSE_LABELS[params.purpose] : undefined;
        const purposeLabel = labels ? (lang === 'en' ? labels.en : labels.ar) : undefined;

        const content = buildOtpEmail({
            name: params.name,
            code: params.otpCode,
            language: lang,
            purposeLabel,
            brand: {
                siteUrl: this.config.siteUrl,
                logoUrl: this.config.logoUrl,
            },
        });

        try {
            const { data, error } = await this.client.emails.send({
                from: this.config.fromEmail,
                to: params.to,
                subject: content.subject,
                html: content.html,
                text: content.text,
            });

            if (error) {
                this.logger.error(`Resend OTP failed → ${maskEmail(params.to)}: ${error.message}`);
                return { sent: false, error: error.message };
            }

            this.logger.log(
                `OTP email sent → ${maskEmail(params.to)} id=${data?.id ?? 'unknown'}`,
            );
            return { sent: true };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error(`Resend OTP exception → ${maskEmail(params.to)}: ${message}`);
            return { sent: false, error: message };
        }
    }
}

function maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!local || !domain) return '***';
    const visible = local.slice(0, Math.min(2, local.length));
    return `${visible}***@${domain}`;
}
