import { Injectable, Logger } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WidersConfig } from './widers.config';
import { WidersService } from './widers.service';
import type { MakeContactPayload, WidersApiResponse } from './widers.types';

export const WIDERS_CONTACT_GROUPS = {
    customer: 'marketplace_customers',
    vendor: 'marketplace_vendors',
} as const;

export const WIDERS_CONTACT_TAGS = {
    lead: 'lead',
    customer: 'عميل',
    vendor: 'مورد',
    registered2026: 'مسجل_2026',
} as const;

export type WidersContactAudience = 'customer' | 'vendor';

export interface SyncLeadParams {
    phone: string;
    email: string;
    name?: string;
    audience: WidersContactAudience;
}

@Injectable()
export class WidersContactSyncService {
    private readonly logger = new Logger(WidersContactSyncService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly widers: WidersService,
        private readonly config: WidersConfig,
    ) {}

    private extractContactId(result: WidersApiResponse): string | null {
        const data = result.data;
        if (!data || typeof data !== 'object') {
            return null;
        }

        const record = data as Record<string, unknown>;
        if (typeof record.id === 'string' || typeof record.id === 'number') {
            return String(record.id);
        }
        if (typeof record.contact_id === 'string' || typeof record.contact_id === 'number') {
            return String(record.contact_id);
        }
        if (typeof record.contactId === 'string' || typeof record.contactId === 'number') {
            return String(record.contactId);
        }

        const nested = record.contact;
        if (nested && typeof nested === 'object') {
            const contact = nested as Record<string, unknown>;
            if (typeof contact.id === 'string' || typeof contact.id === 'number') {
                return String(contact.id);
            }
        }

        return null;
    }

    private buildTags(...parts: string[]): string {
        return parts.filter(Boolean).join(',');
    }

    private audienceFromRole(role: UserRole): WidersContactAudience | null {
        if (role === UserRole.CUSTOMER) return 'customer';
        if (role === UserRole.VENDOR) return 'vendor';
        return null;
    }

    private async callMakeContact(
        payload: MakeContactPayload,
        context: string,
    ): Promise<{ ok: boolean; contactId?: string; skipped?: boolean }> {
        if (!this.config.enabled) {
            this.logger.warn(
                `[DEV] WIDERS_ENABLED=false — skip makeContact (${context}) → ${payload.phone}`,
            );
            return { ok: true, skipped: true };
        }

        const result = await this.widers.makeContact(payload);
        if (!result.success) {
            this.logger.error(`makeContact failed (${context}) → ${payload.phone}: ${result.error}`);
            return { ok: false };
        }

        return { ok: true, contactId: this.extractContactId(result) ?? undefined };
    }

    /**
     * Registration funnel — no User row yet; tag as lead in Widers.
     */
    async syncLead(params: SyncLeadParams): Promise<void> {
        const phone = this.widers.normalizePhone(params.phone);
        const group =
            params.audience === 'vendor'
                ? WIDERS_CONTACT_GROUPS.vendor
                : WIDERS_CONTACT_GROUPS.customer;

        await this.callMakeContact(
            {
                phone,
                name: params.name?.trim() || undefined,
                email: params.email,
                groups: group,
                tags: this.buildTags(WIDERS_CONTACT_TAGS.lead, WIDERS_CONTACT_TAGS.registered2026),
                fields: {
                    preferred_language: 'ar',
                    registration_stage: 'lead',
                },
            },
            `register-init:${params.email}`,
        );
    }

    /**
     * After successful register/customer|vendor — promote lead to full contact.
     */
    async syncRegisteredUser(userId: string): Promise<{ synced: boolean; skipped?: boolean }> {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user?.phone) {
            return { synced: false, skipped: true };
        }

        const audience = this.audienceFromRole(user.role);
        if (!audience) {
            return { synced: false, skipped: true };
        }

        if (!user.whatsappOptIn) {
            return { synced: false, skipped: true };
        }

        const roleTag =
            audience === 'vendor' ? WIDERS_CONTACT_TAGS.vendor : WIDERS_CONTACT_TAGS.customer;

        const result = await this.callMakeContact(
            {
                phone: user.phone,
                name: user.name?.trim() || undefined,
                email: user.email,
                groups:
                    audience === 'vendor'
                        ? WIDERS_CONTACT_GROUPS.vendor
                        : WIDERS_CONTACT_GROUPS.customer,
                tags: this.buildTags(roleTag, WIDERS_CONTACT_TAGS.registered2026),
                fields: {
                    preferred_language: 'ar',
                    registration_stage: 'registered',
                    user_id: user.id,
                    user_role: user.role,
                },
            },
            `register-complete:${user.id}`,
        );

        if (!result.ok) {
            return { synced: false };
        }

        if (!result.skipped) {
            await this.prisma.user.update({
                where: { id: user.id },
                data: {
                    widersContactId: result.contactId ?? user.widersContactId ?? undefined,
                    widersSyncedAt: new Date(),
                },
            });
        }

        return { synced: true, skipped: result.skipped };
    }

    /**
     * On login — backfill contacts created before Phase 4 or when init sync failed.
     */
    async syncOnLoginIfMissing(user: {
        id: string;
        phone: string | null;
        role: UserRole;
        whatsappOptIn: boolean;
        widersContactId: string | null;
    }): Promise<void> {
        if (user.widersContactId) return;
        if (!user.phone || !user.whatsappOptIn) return;
        if (!this.audienceFromRole(user.role)) return;

        await this.syncRegisteredUser(user.id);
    }

    /**
     * Batch backfill for existing CUSTOMER/VENDOR accounts (dev/staging tool).
     */
    async batchSyncMissing(limit = 50): Promise<{
        scanned: number;
        synced: number;
        failed: number;
        skipped: number;
    }> {
        const users = await this.prisma.user.findMany({
            where: {
                widersContactId: null,
                phone: { not: null },
                whatsappOptIn: true,
                role: { in: [UserRole.CUSTOMER, UserRole.VENDOR] },
            },
            take: limit,
            orderBy: { createdAt: 'asc' },
            select: { id: true },
        });

        let synced = 0;
        let failed = 0;
        let skipped = 0;

        for (const { id } of users) {
            const result = await this.syncRegisteredUser(id);
            if (result.skipped) {
                skipped += 1;
            } else if (result.synced) {
                synced += 1;
            } else {
                failed += 1;
            }
        }

        return { scanned: users.length, synced, failed, skipped };
    }
}
