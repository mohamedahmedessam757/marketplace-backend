import { Injectable, Logger } from '@nestjs/common';
import { WidersConfig } from './widers.config';
import type {
    MakeContactPayload,
    SendTemplateMessagePayload,
    WidersApiResponse,
    WidersTemplateComponent,
} from './widers.types';
import { truncateWhatsAppParam } from './template-registry';

const REQUEST_TIMEOUT_MS = 15_000;

@Injectable()
export class WidersService {
    private readonly logger = new Logger(WidersService.name);

    constructor(private readonly widersConfig: WidersConfig) {}

    isReady(): boolean {
        return this.widersConfig.isConfigured();
    }

    /** E.164-ish normalization for Saudi numbers */
    normalizePhone(phone: string): string {
        const digits = phone.replace(/\D/g, '');
        if (digits.startsWith('966')) return `+${digits}`;
        if (digits.startsWith('05')) return `+966${digits.slice(1)}`;
        if (digits.startsWith('5') && digits.length === 9) return `+966${digits}`;
        if (phone.startsWith('+')) return phone;
        return `+${digits}`;
    }

    private async post<T>(
        path: string,
        body: Record<string, unknown>,
    ): Promise<WidersApiResponse<T>> {
        const token = this.widersConfig.apiToken;
        if (!token) {
            return { success: false, error: 'WIDERS_API_TOKEN not configured' };
        }

        const url = this.widersConfig.apiPath(path);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ ...body, token }),
                signal: controller.signal,
            });

            const text = await response.text();
            let parsed: WidersApiResponse<T> = {};
            try {
                parsed = text ? (JSON.parse(text) as WidersApiResponse<T>) : {};
            } catch {
                parsed = { success: false, error: text || response.statusText };
            }

            if (!response.ok) {
                this.logger.warn(
                    `Widers ${path} HTTP ${response.status}: ${parsed.error ?? parsed.message ?? text}`,
                );
                return {
                    ...parsed,
                    success: false,
                    error: parsed.error ?? parsed.message ?? `HTTP ${response.status}`,
                };
            }

            return { ...parsed, success: parsed.success !== false };
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown Widers error';
            this.logger.error(`Widers ${path} failed: ${message}`);
            return { success: false, error: message };
        } finally {
            clearTimeout(timeout);
        }
    }

    private async get<T>(path: string, query: Record<string, string> = {}): Promise<WidersApiResponse<T>> {
        const token = this.widersConfig.apiToken;
        if (!token) {
            return { success: false, error: 'WIDERS_API_TOKEN not configured' };
        }

        const url = new URL(this.widersConfig.apiPath(path));
        url.searchParams.set('token', token);
        for (const [k, v] of Object.entries(query)) {
            url.searchParams.set(k, v);
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(url.toString(), {
                method: 'GET',
                headers: { Accept: 'application/json' },
                signal: controller.signal,
            });

            const text = await response.text();
            let parsed: WidersApiResponse<T> = {};
            try {
                parsed = text ? (JSON.parse(text) as WidersApiResponse<T>) : {};
            } catch {
                parsed = { success: false, error: text || response.statusText };
            }

            if (!response.ok) {
                return {
                    ...parsed,
                    success: false,
                    error: parsed.error ?? parsed.message ?? `HTTP ${response.status}`,
                };
            }

            return { ...parsed, success: parsed.success !== false };
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown Widers error';
            return { success: false, error: message };
        } finally {
            clearTimeout(timeout);
        }
    }

    buildComponents(
        bodyTexts: string[],
        options?: {
            headerText?: string;
            buttonSuffix?: string;
        },
    ): WidersTemplateComponent[] {
        const components: WidersTemplateComponent[] = [];

        if (options?.headerText) {
            components.push({
                type: 'header',
                parameters: [{ type: 'text', text: truncateWhatsAppParam(options.headerText, 60) }],
            });
        }

        if (bodyTexts.length > 0) {
            components.push({
                type: 'body',
                parameters: bodyTexts.map((t) => ({
                    type: 'text' as const,
                    text: truncateWhatsAppParam(t),
                })),
            });
        }

        if (options?.buttonSuffix) {
            components.push({
                type: 'button',
                sub_type: 'url',
                index: '0',
                parameters: [{ type: 'text', text: options.buttonSuffix }],
            });
        }

        return components;
    }

    async sendTemplateMessage(
        payload: SendTemplateMessagePayload,
    ): Promise<WidersApiResponse> {
        if (!this.widersConfig.enabled) {
            this.logger.debug(
                `Widers disabled — skip template ${payload.templateName} to ${payload.phone}`,
            );
            return { success: false, error: 'WIDERS_ENABLED is false' };
        }

        const phone = this.normalizePhone(payload.phone);
        const body: Record<string, unknown> = {
            phone,
            template_name: payload.templateName,
            template_language: payload.templateLanguage,
        };

        if (payload.components?.length) {
            body.components = payload.components;
        }

        this.logger.log(
            `Sending template ${payload.templateName} (${payload.templateLanguage}) → ${phone}`,
        );

        return this.post('sendtemplatemessage', body);
    }

    async makeContact(payload: MakeContactPayload): Promise<WidersApiResponse> {
        if (!this.widersConfig.enabled) {
            return { success: false, error: 'WIDERS_ENABLED is false' };
        }

        const phone = this.normalizePhone(payload.phone);
        const body: Record<string, unknown> = { phone };

        if (payload.name) body.name = payload.name;
        if (payload.email) body.email = payload.email;
        if (payload.groups) body.groups = payload.groups;
        if (payload.tags) body.tags = payload.tags;
        if (payload.fields) Object.assign(body, payload.fields);

        return this.post('makeContact', body);
    }

    async getTemplates(): Promise<WidersApiResponse<unknown[]>> {
        return this.get<unknown[]>('getTemplates');
    }

    async ping(): Promise<{ reachable: boolean; templateCount?: number; error?: string }> {
        if (!this.isReady()) {
            return { reachable: false, error: 'Token not configured' };
        }

        const result = await this.getTemplates();
        if (!result.success) {
            return { reachable: false, error: result.error ?? result.message };
        }

        const data = result.data;
        const count = Array.isArray(data) ? data.length : undefined;
        return { reachable: true, templateCount: count };
    }
}
