import { Injectable, Logger } from '@nestjs/common';
import {
    WhatsAppDeliveryStatus,
    WhatsAppMessageDirection,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { WidersApiResponse } from './widers.types';
import type { MetaStatusError } from './widers-webhook.types';

export interface LogOutboundParams {
    phone: string;
    templateName: string;
    templateLanguage: string;
    recipientUserId?: string;
    notificationId?: string;
    sendResult?: WidersApiResponse;
    metadata?: Record<string, unknown>;
}

@Injectable()
export class WhatsAppMessageLogService {
    private readonly logger = new Logger(WhatsAppMessageLogService.name);

    constructor(private readonly prisma: PrismaService) {}

    extractMessageId(result?: WidersApiResponse): string | null {
        if (!result) return null;
        const candidates: unknown[] = [result.data];
        if (result.data && typeof result.data === 'object') {
            const data = result.data as Record<string, unknown>;
            candidates.push(
                data.message_id,
                data.messageId,
                data.wamid,
                data.id,
                (data.message as Record<string, unknown> | undefined)?.id,
            );
            if (Array.isArray(data.messages) && data.messages[0]) {
                const first = data.messages[0] as Record<string, unknown>;
                candidates.push(first.id);
            }
        }
        for (const value of candidates) {
            if (typeof value === 'string' && value.trim()) {
                return value.trim();
            }
        }
        return null;
    }

    async logOutbound(params: LogOutboundParams): Promise<string> {
        const externalMessageId = this.extractMessageId(params.sendResult);
        const sent = params.sendResult?.success !== false;

        const log = await this.prisma.whatsAppMessageLog.create({
            data: {
                externalMessageId: externalMessageId ?? undefined,
                direction: WhatsAppMessageDirection.OUTBOUND,
                phone: params.phone,
                templateName: params.templateName,
                templateLanguage: params.templateLanguage,
                deliveryStatus: sent
                    ? externalMessageId
                        ? WhatsAppDeliveryStatus.SENT
                        : WhatsAppDeliveryStatus.QUEUED
                    : WhatsAppDeliveryStatus.FAILED,
                recipientUserId: params.recipientUserId,
                notificationId: params.notificationId,
                errorMessage: sent
                    ? undefined
                    : params.sendResult?.error ?? params.sendResult?.message,
                payload: (params.sendResult ?? {}) as object,
                metadata: (params.metadata ?? {}) as object,
                sentAt: sent ? new Date() : undefined,
                failedAt: sent ? undefined : new Date(),
            },
        });

        return log.id;
    }

    async applyStatusUpdate(input: {
        messageId: string;
        status: string;
        phone?: string;
        timestamp?: Date;
        errors?: MetaStatusError[];
        raw?: Record<string, unknown>;
    }): Promise<{ updated: boolean; created: boolean }> {
        const mapped = this.mapDeliveryStatus(input.status);
        const error = input.errors?.[0];
        const now = input.timestamp ?? new Date();

        const existing = await this.prisma.whatsAppMessageLog.findUnique({
            where: { externalMessageId: input.messageId },
        });

        const statusTimes = this.statusTimestamps(mapped, now);

        if (existing) {
            await this.prisma.whatsAppMessageLog.update({
                where: { id: existing.id },
                data: {
                    deliveryStatus: mapped,
                    phone: input.phone ?? existing.phone,
                    errorCode: error?.code != null ? String(error.code) : existing.errorCode,
                    errorMessage:
                        error?.title ?? error?.message ?? existing.errorMessage,
                    payload: {
                        ...(existing.payload as object),
                        lastWebhook: input.raw ?? {},
                    } as object,
                    ...statusTimes,
                    updatedAt: new Date(),
                },
            });
            return { updated: true, created: false };
        }

        await this.prisma.whatsAppMessageLog.create({
            data: {
                externalMessageId: input.messageId,
                direction: WhatsAppMessageDirection.OUTBOUND,
                phone: input.phone,
                deliveryStatus: mapped,
                errorCode: error?.code != null ? String(error.code) : undefined,
                errorMessage: error?.title ?? error?.message,
                payload: (input.raw ?? {}) as object,
                ...statusTimes,
            },
        });

        this.logger.debug(
            `Created message log from webhook for unknown wamid ${input.messageId}`,
        );
        return { updated: false, created: true };
    }

    async logInbound(input: {
        messageId: string;
        phone: string;
        text?: string;
        timestamp?: Date;
        raw?: Record<string, unknown>;
    }): Promise<void> {
        const existing = await this.prisma.whatsAppMessageLog.findUnique({
            where: { externalMessageId: input.messageId },
        });
        if (existing) return;

        await this.prisma.whatsAppMessageLog.create({
            data: {
                externalMessageId: input.messageId,
                direction: WhatsAppMessageDirection.INBOUND,
                phone: input.phone,
                deliveryStatus: WhatsAppDeliveryStatus.DELIVERED,
                payload: (input.raw ?? {}) as object,
                metadata: { text: input.text } as object,
                deliveredAt: input.timestamp ?? new Date(),
            },
        });
    }

    async listRecent(limit = 50) {
        return this.prisma.whatsAppMessageLog.findMany({
            orderBy: { createdAt: 'desc' },
            take: Math.min(Math.max(limit, 1), 200),
            select: {
                id: true,
                externalMessageId: true,
                direction: true,
                phone: true,
                templateName: true,
                deliveryStatus: true,
                errorCode: true,
                errorMessage: true,
                sentAt: true,
                deliveredAt: true,
                readAt: true,
                failedAt: true,
                createdAt: true,
            },
        });
    }

    private mapDeliveryStatus(status: string): WhatsAppDeliveryStatus {
        const normalized = status.toLowerCase();
        switch (normalized) {
            case 'sent':
                return WhatsAppDeliveryStatus.SENT;
            case 'delivered':
                return WhatsAppDeliveryStatus.DELIVERED;
            case 'read':
                return WhatsAppDeliveryStatus.READ;
            case 'failed':
                return WhatsAppDeliveryStatus.FAILED;
            default:
                return WhatsAppDeliveryStatus.UNKNOWN;
        }
    }

    private statusTimestamps(
        status: WhatsAppDeliveryStatus,
        at: Date,
    ): Partial<{
        sentAt: Date;
        deliveredAt: Date;
        readAt: Date;
        failedAt: Date;
    }> {
        switch (status) {
            case WhatsAppDeliveryStatus.SENT:
                return { sentAt: at };
            case WhatsAppDeliveryStatus.DELIVERED:
                return { deliveredAt: at };
            case WhatsAppDeliveryStatus.READ:
                return { readAt: at };
            case WhatsAppDeliveryStatus.FAILED:
                return { failedAt: at };
            default:
                return {};
        }
    }
}
