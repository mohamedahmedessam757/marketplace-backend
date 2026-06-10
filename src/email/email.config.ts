import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EmailConfig {
    readonly enabled: boolean;
    readonly apiKey: string | undefined;
    readonly fromEmail: string;
    readonly siteUrl: string;
    readonly logoUrl: string;

    constructor(private readonly config: ConfigService) {
        this.enabled = this.config.get<string>('RESEND_ENABLED') === 'true';
        this.apiKey = this.config.get<string>('RESEND_API_KEY')?.trim();
        this.fromEmail =
            this.config.get<string>('RESEND_FROM_EMAIL')?.trim() ||
            'E-Tshaleh <noreply@e-tashleh.net>';

        const configuredSite =
            this.config.get<string>('RESEND_SITE_URL')?.trim() ||
            this.config.get<string>('FRONTEND_URL')?.trim()?.replace(/\/$/, '');
        const isLocal =
            !configuredSite ||
            configuredSite.includes('localhost') ||
            configuredSite.includes('127.0.0.1');
        this.siteUrl = isLocal
            ? 'https://e-tashleh.net'
            : configuredSite.replace(/^["']|["']$/g, '');

        this.logoUrl =
            this.config.get<string>('RESEND_LOGO_URL')?.trim() ||
            `${this.siteUrl}/logo.png`;
    }

    isConfigured(): boolean {
        return Boolean(this.apiKey);
    }
}
