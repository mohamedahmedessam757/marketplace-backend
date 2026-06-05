import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WidersConfig } from './widers.config';
import { WidersService } from './widers.service';
import { TEMPLATE_REGISTRY } from './template-registry';

export type ReadinessStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface ReadinessCheck {
    id: string;
    label: string;
    status: ReadinessStatus;
    detail?: string;
}

export interface WidersReadinessReport {
    readyForProduction: boolean;
    widersEnabled: boolean;
    environment: string;
    checks: ReadinessCheck[];
    qaDoc: string;
    summary: {
        pass: number;
        warn: number;
        fail: number;
        skip: number;
    };
}

@Injectable()
export class WidersReadinessService {
    constructor(
        private readonly config: WidersConfig,
        private readonly widers: WidersService,
        private readonly prisma: PrismaService,
    ) {}

    async evaluate(): Promise<WidersReadinessReport> {
        const checks: ReadinessCheck[] = [];
        const isProd = process.env.NODE_ENV === 'production';

        checks.push({
            id: 'widers_enabled_flag',
            label: 'WIDERS_ENABLED',
            status: this.config.enabled ? (isProd ? 'pass' : 'warn') : 'skip',
            detail: this.config.enabled
                ? 'Live WhatsApp sends are ON'
                : 'Dev-safe: OTP logged to console; no real sends',
        });

        checks.push({
            id: 'api_token',
            label: 'WIDERS_API_TOKEN',
            status: this.widers.isReady() ? 'pass' : 'fail',
            detail: this.widers.isReady() ? 'Token configured' : 'Missing token',
        });

        checks.push({
            id: 'webhook_secret',
            label: 'WIDERS_WEBHOOK_SECRET',
            status: this.config.webhookSecret
                ? 'pass'
                : isProd && this.config.enabled
                  ? 'fail'
                  : 'warn',
            detail: this.config.webhookSecret
                ? 'Webhook auth configured'
                : 'Set secret + same value in Widers sender URL ?token=',
        });

        checks.push({
            id: 'frontend_url',
            label: 'FRONTEND_URL (CTA buttons)',
            status: this.config.frontendUrl ? 'pass' : 'fail',
            detail: this.config.frontendUrl ?? 'Required for invoice/order deep links',
        });

        checks.push({
            id: 'otp_mode',
            label: 'WIDERS_OTP_MODE',
            status: 'pass',
            detail: `Current: ${this.config.otpMode} (utility until Meta Authentication approved)`,
        });

        const ping = this.widers.isReady()
            ? await this.widers.ping()
            : { reachable: false, error: 'No token' };
        checks.push({
            id: 'api_reachable',
            label: 'Widers API reachable',
            status: ping.reachable ? 'pass' : this.config.enabled ? 'fail' : 'warn',
            detail: ping.reachable
                ? `Templates in account: ${ping.templateCount ?? '?'}`
                : ping.error ?? 'Unreachable',
        });

        checks.push({
            id: 'template_registry',
            label: 'Code template registry',
            status: TEMPLATE_REGISTRY.length >= 10 ? 'pass' : 'warn',
            detail: `${TEMPLATE_REGISTRY.length} families registered in code`,
        });

        try {
            await this.prisma.whatsAppMessageLog.count({ take: 1 });
            checks.push({
                id: 'message_log_table',
                label: 'whatsapp_message_logs table',
                status: 'pass',
            });
        } catch {
            checks.push({
                id: 'message_log_table',
                label: 'whatsapp_message_logs table',
                status: 'fail',
                detail: 'Run migration 20260608_whatsapp_message_logs.sql',
            });
        }

        try {
            await this.prisma.widersWebhookEvent.count({ take: 1 });
            checks.push({
                id: 'webhook_events_table',
                label: 'widers_webhook_events table',
                status: 'pass',
            });
        } catch {
            checks.push({
                id: 'webhook_events_table',
                label: 'widers_webhook_events table',
                status: 'fail',
                detail: 'Run migration 20260608_whatsapp_message_logs.sql',
            });
        }

        checks.push({
            id: 'test_endpoints_locked',
            label: 'Dev test endpoints blocked in production',
            status: isProd ? 'pass' : 'skip',
            detail: '/widers/test/otp, /contacts/sync-batch, /webhook/logs',
        });

        checks.push({
            id: 'meta_templates_approved',
            label: 'Meta templates APPROVED (manual)',
            status: 'warn',
            detail: 'User action: approve all txn_* + auth_otp in Widers dashboard',
        });

        checks.push({
            id: 'webhook_sender_url',
            label: 'Widers Webhook (sender) URL (manual)',
            status: 'warn',
            detail: 'Must point to https://YOUR_API/widers/webhook?token=SECRET',
        });

        const summary = {
            pass: checks.filter((c) => c.status === 'pass').length,
            warn: checks.filter((c) => c.status === 'warn').length,
            fail: checks.filter((c) => c.status === 'fail').length,
            skip: checks.filter((c) => c.status === 'skip').length,
        };

        const blockingFails = checks.filter(
            (c) => c.status === 'fail' && c.id !== 'api_reachable',
        );
        const readyForProduction =
            blockingFails.length === 0 &&
            (!this.config.enabled || (ping.reachable && Boolean(this.config.webhookSecret)));

        return {
            readyForProduction,
            widersEnabled: this.config.enabled,
            environment: process.env.NODE_ENV ?? 'development',
            checks,
            qaDoc: 'docs/WIDERS_PHASE7_QA_SECURITY.md',
            summary,
        };
    }
}
