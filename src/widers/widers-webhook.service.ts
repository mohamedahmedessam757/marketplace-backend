import {
    ForbiddenException,
    Injectable,
    Logger,
    UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WidersConfig } from './widers.config';
import { WhatsAppMessageLogService } from './whatsapp-message-log.service';
import type {
    FlatWidersWebhookPayload,
    MetaWebhookPayload,
    ParsedWebhookInbound,
    ParsedWebhookStatus,
} from './widers-webhook.types';

@Injectable()
export class WidersWebhookService {
    private readonly logger = new Logger(WidersWebhookService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly config: WidersConfig,
        private readonly messageLog: WhatsAppMessageLogService,
    ) {}

    verifyMetaChallenge(
        mode: string | undefined,
        token: string | undefined,
        challenge: string | undefined,
    ): string {
        const secret = this.config.webhookSecret;
        if (!secret) {
            throw new ForbiddenException('WIDERS_WEBHOOK_SECRET not configured');
        }
        if (mode === 'subscribe' && this.tokensMatch(token, secret) && challenge) {
            return challenge;
        }
        throw new UnauthorizedException('Invalid webhook verify token');
    }

    assertAuthorized(
        queryToken?: string,
        headerToken?: string,
    ): void {
        const secret = this.config.webhookSecret;
        if (!secret) {
            if (process.env.NODE_ENV === 'production') {
                throw new ForbiddenException('WIDERS_WEBHOOK_SECRET not configured');
            }
            return;
        }

        const provided = queryToken ?? headerToken;
        if (!provided || !this.tokensMatch(provided, secret)) {
            throw new UnauthorizedException('Invalid Widers webhook token');
        }
    }

    private tokensMatch(provided: string | undefined, expected: string): boolean {
        if (!provided || !expected) return false;
        const a = Buffer.from(provided);
        const b = Buffer.from(expected);
        if (a.length !== b.length) return false;
        return timingSafeEqual(a, b);
    }

    parsePayload(body: Record<string, unknown>): {
        statuses: ParsedWebhookStatus[];
        inbound: ParsedWebhookInbound[];
    } {
        const statuses: ParsedWebhookStatus[] = [];
        const inbound: ParsedWebhookInbound[] = [];

        const meta = body as MetaWebhookPayload;
        if (Array.isArray(meta.entry)) {
            for (const entry of meta.entry) {
                for (const change of entry.changes ?? []) {
                    const value = change.value;
                    if (!value) continue;

                    for (const status of value.statuses ?? []) {
                        if (!status?.id || !status.status) continue;
                        const ts = this.parseTimestamp(status.timestamp);
                        statuses.push({
                            eventKey: `${status.id}:${status.status}:${status.timestamp ?? '0'}`,
                            messageId: status.id,
                            status: status.status,
                            phone: status.recipient_id,
                            timestamp: ts,
                            errors: status.errors,
                            raw: status as unknown as Record<string, unknown>,
                        });
                    }

                    for (const message of value.messages ?? []) {
                        if (!message?.id || !message.from) continue;
                        inbound.push({
                            eventKey: `${message.id}:inbound:${message.timestamp ?? '0'}`,
                            messageId: message.id,
                            phone: message.from,
                            text: message.text?.body,
                            timestamp: this.parseTimestamp(message.timestamp),
                            raw: message as unknown as Record<string, unknown>,
                        });
                    }
                }
            }
        }

        const flat = body as FlatWidersWebhookPayload;
        const flatMessageId =
            flat.message_id ?? flat.messageId ?? flat.wamid ?? undefined;
        if (flatMessageId && flat.status) {
            statuses.push({
                eventKey: `${flatMessageId}:${flat.status}:${flat.timestamp ?? '0'}`,
                messageId: flatMessageId,
                status: flat.status,
                phone: flat.phone,
                timestamp: this.parseTimestamp(flat.timestamp),
                errors: flat.errors,
                raw: body,
            });
        }

        const data = flat.data;
        if (data && typeof data === 'object') {
            const nested = this.parsePayload(data as Record<string, unknown>);
            statuses.push(...nested.statuses);
            inbound.push(...nested.inbound);
        }

        return { statuses, inbound };
    }

    async processWebhook(body: Record<string, unknown>): Promise<{
        received: boolean;
        duplicate?: boolean;
        processed: number;
        skipped: number;
    }> {
        const { statuses, inbound } = this.parsePayload(body);

        if (statuses.length === 0 && inbound.length === 0) {
            this.logger.debug('Widers webhook: no actionable statuses or messages');
            return { received: true, processed: 0, skipped: 0 };
        }

        let processed = 0;
        let skipped = 0;

        for (const status of statuses) {
            const duplicate = await this.isDuplicateEvent(status.eventKey);
            if (duplicate) {
                skipped += 1;
                continue;
            }

            await this.markEventProcessing(status.eventKey, 'message.status', body);
            try {
                await this.messageLog.applyStatusUpdate({
                    messageId: status.messageId,
                    status: status.status,
                    phone: status.phone,
                    timestamp: status.timestamp,
                    errors: status.errors,
                    raw: status.raw,
                });
                await this.markEventSuccess(status.eventKey);
                processed += 1;
            } catch (err) {
                await this.markEventFailed(status.eventKey);
                throw err;
            }
        }

        for (const message of inbound) {
            const duplicate = await this.isDuplicateEvent(message.eventKey);
            if (duplicate) {
                skipped += 1;
                continue;
            }

            await this.markEventProcessing(message.eventKey, 'message.inbound', body);
            try {
                await this.messageLog.logInbound({
                    messageId: message.messageId,
                    phone: message.phone,
                    text: message.text,
                    timestamp: message.timestamp,
                    raw: message.raw,
                });
                await this.markEventSuccess(message.eventKey);
                processed += 1;
            } catch (err) {
                await this.markEventFailed(message.eventKey);
                throw err;
            }
        }

        return { received: true, processed, skipped };
    }

    private parseTimestamp(raw?: string | number): Date | undefined {
        if (raw == null || raw === '') return undefined;
        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds > 0) {
            return new Date(seconds * 1000);
        }
        const parsed = Date.parse(String(raw));
        return Number.isFinite(parsed) ? new Date(parsed) : undefined;
    }

    private async isDuplicateEvent(eventKey: string): Promise<boolean> {
        const existing = await this.prisma.widersWebhookEvent.findUnique({
            where: { id: eventKey },
            select: { status: true },
        });
        return existing?.status === 'SUCCESS';
    }

    private async markEventProcessing(
        eventKey: string,
        eventType: string,
        payload: Record<string, unknown>,
    ): Promise<void> {
        await this.prisma.widersWebhookEvent.upsert({
            where: { id: eventKey },
            create: {
                id: eventKey,
                eventType,
                status: 'PROCESSING',
                payload: payload as object,
            },
            update: {
                eventType,
                status: 'PROCESSING',
                processedAt: new Date(),
            },
        });
    }

    private async markEventSuccess(eventKey: string): Promise<void> {
        await this.prisma.widersWebhookEvent.update({
            where: { id: eventKey },
            data: { status: 'SUCCESS', processedAt: new Date() },
        });
    }

    private async markEventFailed(eventKey: string): Promise<void> {
        await this.prisma.widersWebhookEvent.update({
            where: { id: eventKey },
            data: { status: 'FAILED', processedAt: new Date() },
        });
    }
}
