import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WidersConfig } from './widers.config';
import { WidersService } from './widers.service';
import {
    buildButtonSuffix,
    getTemplateDefinition,
    resolveTemplateName,
    truncateWhatsAppParam,
    type TemplateBodyField,
} from './template-registry';
import type { WidersTemplateLanguage } from './widers.types';
import {
    extractOfferId,
    extractOrderId,
    isWhatsAppEligibleRole,
    normalizeWhatsAppRole,
    resolveTemplateFamily,
    type NotificationDispatchInput,
} from './whatsapp-notification.mapper';
import { WhatsAppMessageLogService } from './whatsapp-message-log.service';

export interface WhatsAppDispatchContext {
    phone: string;
    language?: WidersTemplateLanguage;
    fields: Partial<Record<TemplateBodyField, string>>;
    orderId?: string;
    offerId?: string;
    logContext?: {
        recipientUserId?: string;
        notificationId?: string;
    };
}

/**
 * High-level dispatcher — wired to NotificationsService in Phase 5.
 * Phase 1: infrastructure + send helpers only.
 */
export interface WhatsAppMaybeSendParams extends NotificationDispatchInput {
    recipientId: string;
}

@Injectable()
export class WhatsAppChannelService {
    private readonly logger = new Logger(WhatsAppChannelService.name);

    constructor(
        private readonly widers: WidersService,
        private readonly config: WidersConfig,
        private readonly prisma: PrismaService,
        private readonly messageLog: WhatsAppMessageLogService,
    ) {}

    resolveLanguage(preferred?: string | null): WidersTemplateLanguage {
        return preferred === 'en' ? 'en' : 'ar';
    }

    buildCtaSuffix(pattern: string, orderId?: string, offerId?: string): string {
        return buildButtonSuffix(pattern, { orderId, offerId });
    }

    async sendByFamily(
        familyBase: string,
        ctx: WhatsAppDispatchContext,
    ): Promise<{ sent: boolean; error?: string; templateName?: string }> {
        const lang = ctx.language ?? 'ar';
        const templateName = resolveTemplateName(familyBase, lang);
        const definition = getTemplateDefinition(templateName);

        if (!definition) {
            // Fallback to Arabic if English template not registered yet
            if (lang === 'en') {
                this.logger.warn(`Template ${templateName} missing — fallback to _ar`);
                return this.sendByFamily(familyBase, { ...ctx, language: 'ar' });
            }
            return { sent: false, error: `Unknown template: ${templateName}` };
        }

        const bodyTexts = definition.bodyFields.map((field) => {
            const raw = ctx.fields[field];
            if (field === 'tracking_number' && !raw) return 'غير متوفر';
            if (field === 'summary' && !raw) return '-';
            return truncateWhatsAppParam(raw ?? '');
        });

        const buttonSuffix = definition.buttonSuffixPattern
            ? this.buildCtaSuffix(definition.buttonSuffixPattern, ctx.orderId, ctx.offerId)
            : undefined;

        const result = await this.widers.sendTemplateMessage({
            phone: ctx.phone,
            templateName: definition.name,
            templateLanguage: definition.language,
            components: this.widers.buildComponents(bodyTexts, {
                headerText: definition.headerText,
                buttonSuffix,
            }),
        });

        void this.messageLog
            .logOutbound({
                phone: ctx.phone,
                templateName: definition.name,
                templateLanguage: definition.language,
                recipientUserId: ctx.logContext?.recipientUserId,
                notificationId: ctx.logContext?.notificationId,
                sendResult: result,
                metadata: {
                    familyBase: familyBase,
                    orderId: ctx.orderId,
                    offerId: ctx.offerId,
                },
            })
            .catch((err) =>
                this.logger.warn(
                    `Failed to persist WhatsApp message log: ${err instanceof Error ? err.message : err}`,
                ),
            );

        if (!result.success) {
            return {
                sent: false,
                error: result.error ?? result.message,
                templateName: definition.name,
            };
        }

        return { sent: true, templateName: definition.name };
    }

    async sendOtp(
        audience: 'customer' | 'vendor',
        phone: string,
        name: string,
        otpCode: string,
        language?: WidersTemplateLanguage,
    ): Promise<{ sent: boolean; error?: string }> {
        const family = audience === 'vendor' ? 'auth_otp_vendor' : 'auth_otp_customer';
        const lang = language ?? 'ar';

        if (this.config.otpMode === 'authentication') {
            // Meta Authentication templates: OTP in body + button (Phase 2+)
            const templateName = resolveTemplateName(family, lang);
            const result = await this.widers.sendTemplateMessage({
                phone,
                templateName,
                templateLanguage: lang,
                components: [
                    {
                        type: 'body',
                        parameters: [{ type: 'text', text: otpCode }],
                    },
                    {
                        type: 'button',
                        sub_type: 'otp',
                        index: '0',
                        parameters: [{ type: 'text', text: otpCode }],
                    },
                ],
            });
            return {
                sent: Boolean(result.success),
                error: result.error ?? result.message,
            };
        }

        return this.sendByFamily(family, {
            phone,
            language: lang,
            fields: {
                name: truncateWhatsAppParam(name || 'مستخدم', 60),
                otp_code: otpCode,
            },
        });
    }

    /**
     * Phase 5 — dispatch transactional WhatsApp after in-app notification persist.
     * Fire-and-forget safe: never throws to caller.
     */
    async maybeSend(params: WhatsAppMaybeSendParams): Promise<void> {
        if (!this.config.enabled) return;
        if (!isWhatsAppEligibleRole(params.recipientRole)) return;

        const audienceRole = normalizeWhatsAppRole(params.recipientRole);
        if (!audienceRole) return;

        try {
            const user = await this.prisma.user.findUnique({
                where: { id: params.recipientId },
                select: {
                    phone: true,
                    name: true,
                    whatsappOptIn: true,
                    settings: { select: { preferredLanguage: true } },
                    store: { select: { name: true } },
                },
            });

            if (!user?.phone || user.whatsappOptIn === false) return;

            const orderId = extractOrderId(params.metadata, params.link);
            const offerId = extractOfferId(params.metadata);
            const invoiceContext = await this.resolveInvoiceContext(
                params,
                orderId,
                offerId,
            );

            const family = resolveTemplateFamily(params, audienceRole, {
                hasInvoice: invoiceContext.hasInvoice,
            });
            if (!family) return;

            const lang = this.resolveLanguage(user.settings?.preferredLanguage);
            const statusDetail = lang === 'en' ? params.messageEn : params.messageAr;
            const orderNumber = await this.resolveOrderNumber(orderId, params);

            const fields: Partial<Record<TemplateBodyField, string>> = {
                name: truncateWhatsAppParam(user.name || 'مستخدم', 60),
                order_number: orderNumber,
                status_detail: statusDetail,
            };

            if (family.startsWith('txn_shipment_')) {
                fields.tracking_number = await this.resolveTrackingNumber(
                    orderId,
                    params.metadata,
                );
            }

            if (family.startsWith('txn_invoice_')) {
                fields.invoice_number = invoiceContext.invoiceNumber ?? '-';
                fields.amount = invoiceContext.amount ?? this.formatAmount(params.metadata?.amount);
                fields.summary = truncateWhatsAppParam(statusDetail, 200);
            }

            if (family.startsWith('txn_document_')) {
                fields.store_name = truncateWhatsAppParam(
                    user.store?.name || user.name || 'متجر',
                    60,
                );
                fields.doc_type = truncateWhatsAppParam(
                    String(params.metadata?.docType ?? 'مستند'),
                    60,
                );
                fields.status_detail = statusDetail;
            }

            const result = await this.sendByFamily(family, {
                phone: user.phone,
                language: lang,
                fields,
                orderId: orderId ?? undefined,
                offerId: invoiceContext.offerId ?? offerId ?? undefined,
                logContext: { recipientUserId: params.recipientId },
            });

            if (!result.sent) {
                this.logger.warn(
                    `WhatsApp maybeSend failed (${family}) → ${user.phone}: ${result.error}`,
                );
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`WhatsApp maybeSend error for ${params.recipientId}: ${message}`);
        }
    }

    private formatAmount(raw: unknown): string {
        if (raw == null || raw === '') return '-';
        const n = Number(raw);
        if (Number.isFinite(n)) return `${n} AED`;
        return String(raw);
    }

    private async resolveOrderNumber(
        orderId: string | null,
        params: NotificationDispatchInput,
    ): Promise<string> {
        if (orderId) {
            const order = await this.prisma.order.findUnique({
                where: { id: orderId },
                select: { orderNumber: true },
            });
            if (order?.orderNumber) return order.orderNumber;
        }

        const metaNum = params.metadata?.orderNumber;
        if (typeof metaNum === 'string' && metaNum.trim()) {
            return metaNum;
        }

        const blob = `${params.messageAr} ${params.messageEn}`;
        const match = blob.match(/#([A-Z0-9-]+)/i);
        return match?.[1] ?? '-';
    }

    private async resolveTrackingNumber(
        orderId: string | null,
        metadata?: Record<string, unknown> | null,
    ): Promise<string> {
        const fromMeta = metadata?.trackingNumber;
        if (typeof fromMeta === 'string' && fromMeta.trim()) {
            return fromMeta;
        }

        if (!orderId) return 'غير متوفر';

        const shipment = await this.prisma.shipment.findFirst({
            where: { orderId },
            orderBy: { updatedAt: 'desc' },
            select: { trackingNumber: true },
        });

        return shipment?.trackingNumber?.trim() || 'غير متوفر';
    }

    private async resolveInvoiceContext(
        params: NotificationDispatchInput,
        orderId: string | null,
        offerId: string | null,
    ): Promise<{
        hasInvoice: boolean;
        invoiceNumber?: string;
        amount?: string;
        offerId?: string;
    }> {
        const type = (params.type ?? '').toLowerCase();
        if (type !== 'payment') {
            return { hasInvoice: false };
        }

        const metaInvoice = params.metadata?.invoiceNumber;
        if (typeof metaInvoice === 'string' && metaInvoice.trim()) {
            return {
                hasInvoice: true,
                invoiceNumber: metaInvoice,
                amount: this.formatAmount(params.metadata?.amount),
                offerId: offerId ?? undefined,
            };
        }

        if (!offerId) {
            return { hasInvoice: false };
        }

        const payment = await this.prisma.paymentTransaction.findFirst({
            where: { offerId, status: 'SUCCESS' },
            orderBy: { createdAt: 'desc' },
            select: { id: true, totalAmount: true, offerId: true },
        });

        if (!payment) {
            return { hasInvoice: false };
        }

        const invoice = await this.prisma.invoice.findFirst({
            where: { paymentId: payment.id },
            select: { invoiceNumber: true, total: true, currency: true },
        });

        if (!invoice) {
            return { hasInvoice: false };
        }

        return {
            hasInvoice: true,
            invoiceNumber: invoice.invoiceNumber,
            amount: `${invoice.total} ${invoice.currency}`,
            offerId: payment.offerId,
        };
    }
}
