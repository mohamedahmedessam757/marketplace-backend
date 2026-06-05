import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WidersOtpMode } from './widers.types';

@Injectable()
export class WidersConfig {
    readonly enabled: boolean;
    readonly apiToken: string | undefined;
    readonly apiBaseUrl: string;
    readonly frontendUrl: string | undefined;
    readonly testPhone: string | undefined;
    readonly otpMode: WidersOtpMode;
    readonly webhookSecret: string | undefined;

    constructor(private readonly config: ConfigService) {
        this.enabled = this.config.get<string>('WIDERS_ENABLED') === 'true';
        this.apiToken = this.config.get<string>('WIDERS_API_TOKEN')?.trim();
        this.apiBaseUrl = (
            this.config.get<string>('WIDERS_API_BASE_URL')?.trim() ||
            'https://apps.widers.net'
        ).replace(/\/$/, '');
        this.frontendUrl = this.config.get<string>('FRONTEND_URL')?.trim()?.replace(/\/$/, '');
        this.testPhone = this.config.get<string>('WIDERS_TEST_PHONE')?.trim();
        this.otpMode =
            this.config.get<string>('WIDERS_OTP_MODE') === 'authentication'
                ? 'authentication'
                : 'utility';
        this.webhookSecret = this.config.get<string>('WIDERS_WEBHOOK_SECRET')?.trim();
    }

    isConfigured(): boolean {
        return Boolean(this.apiToken);
    }

    apiPath(segment: string): string {
        const base = this.apiBaseUrl.endsWith('/api/wpbox')
            ? this.apiBaseUrl
            : `${this.apiBaseUrl}/api/wpbox`;
        return `${base}/${segment.replace(/^\//, '')}`;
    }
}
