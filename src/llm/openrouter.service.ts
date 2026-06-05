import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'qwen/qwen3.5-flash-02-23';
/** Prevent cost/abuse via oversized chat payloads sent to the LLM provider */
const MAX_INPUT_CHARS = 8_000;
/** Cap stored translation length (DB + UI) */
const MAX_OUTPUT_CHARS = 10_000;

const ALLOWED_MODELS = new Set([DEFAULT_MODEL]);

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

interface OpenRouterChoice {
    message?: { content?: string };
}

interface OpenRouterResponse {
    choices?: OpenRouterChoice[];
    error?: { message?: string };
}

@Injectable()
export class OpenRouterService {
    private readonly logger = new Logger(OpenRouterService.name);
    private readonly apiKey: string | undefined;
    private readonly model: string;
    private readonly siteUrl: string | undefined;
    private readonly appName: string | undefined;

    constructor(private configService: ConfigService) {
        this.apiKey = this.configService.get<string>('OPENROUTER_API_KEY');
        const configuredModel =
            this.configService.get<string>('OPENROUTER_MODEL')?.trim() || DEFAULT_MODEL;
        if (!ALLOWED_MODELS.has(configuredModel)) {
            this.logger.warn(
                `OPENROUTER_MODEL "${configuredModel}" is not allowlisted; using ${DEFAULT_MODEL}`,
            );
            this.model = DEFAULT_MODEL;
        } else {
            this.model = configuredModel;
        }
        this.siteUrl = this.configService.get<string>('OPENROUTER_SITE_URL');
        this.appName =
            this.configService.get<string>('OPENROUTER_APP_NAME') ||
            'E-Tashleh Marketplace';
        if (!this.apiKey) {
            this.logger.warn('OPENROUTER_API_KEY is not set — chat AI features disabled');
        }
    }

    isConfigured(): boolean {
        return Boolean(this.apiKey?.trim());
    }

    private normalizeInput(text: string): string | null {
        const trimmed = text.trim();
        if (!trimmed) return null;
        if (trimmed.length > MAX_INPUT_CHARS) {
            return trimmed.slice(0, MAX_INPUT_CHARS);
        }
        return trimmed;
    }

    private sanitizeModelOutput(text: string): string {
        return text
            .replace(/\0/g, '')
            .trim()
            .slice(0, MAX_OUTPUT_CHARS);
    }

    async classifyContactSharing(text: string): Promise<'CLEAN' | 'VIOLATION' | null> {
        if (!this.isConfigured()) return null;
        const userText = this.normalizeInput(text);
        if (!userText) return null;

        const systemPrompt = `You are a strict chat filter for a marketplace platform.
Your task is to detect if the user is trying to share contact information (phone numbers, emails, website links, or WhatsApp) to bypass the system.
This includes obfuscated attempts (e.g. spelling numbers as words, "my number is", "واتس", "رقمي").
Reply with exactly one word: VIOLATION or CLEAN. Do not explain or add anything else.`;

        const raw = await this.complete(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userText },
            ],
            { maxTokens: 10, timeoutMs: 8_000 },
        );
        if (!raw) return null;

        const verdict = this.sanitizeModelOutput(raw).toUpperCase();
        if (verdict.includes('VIOLATION')) return 'VIOLATION';
        if (verdict.includes('CLEAN')) return 'CLEAN';
        return null;
    }

    async translateMarketplaceMessage(text: string): Promise<string | null> {
        if (!this.isConfigured()) return null;
        const userText = this.normalizeInput(text);
        if (!userText) return null;

        const systemPrompt = `You are a universal translator Translate marketplace chat messages. Arabic→English, English→Arabic. Output only the translation No quotes, labels, or explanations.`;

        const raw = await this.complete(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userText },
            ],
            { maxTokens: 512, timeoutMs: 15_000 },
        );
        if (!raw?.trim()) return null;
        return this.sanitizeModelOutput(raw);
    }

    private async complete(
        messages: ChatMessage[],
        options: { maxTokens: number; timeoutMs: number },
    ): Promise<string | null> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

        try {
            const headers: Record<string, string> = {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
            };
            if (this.siteUrl) headers['HTTP-Referer'] = this.siteUrl;
            if (this.appName) headers['X-OpenRouter-Title'] = this.appName;

            const res = await fetch(OPENROUTER_CHAT_URL, {
                method: 'POST',
                headers,
                signal: controller.signal,
                body: JSON.stringify({
                    model: this.model,
                    messages,
                    temperature: 0,
                    max_tokens: options.maxTokens,
                }),
            });

            const body = (await res.json()) as OpenRouterResponse;

            if (!res.ok) {
                this.logger.error(
                    `OpenRouter HTTP ${res.status}: ${body?.error?.message ?? res.statusText}`,
                );
                return null;
            }

            const content = body.choices?.[0]?.message?.content;
            return typeof content === 'string' ? content : null;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('abort')) {
                this.logger.warn('OpenRouter request timed out');
            } else {
                this.logger.error(`OpenRouter request failed: ${msg}`);
            }
            return null;
        } finally {
            clearTimeout(timeout);
        }
    }
}
