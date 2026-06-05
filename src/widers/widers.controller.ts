import {
    Controller,
    ForbiddenException,
    Get,
    Post,
    Body,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { WidersConfig } from './widers.config';
import { WidersService } from './widers.service';
import { WhatsAppChannelService } from './whatsapp-channel.service';
import { WidersContactSyncService } from './widers-contact-sync.service';
import { WidersReadinessService } from './widers-readiness.service';
import { TEMPLATE_REGISTRY } from './template-registry';
import type { WidersHealthStatus } from './widers.types';

class TestOtpDto {
    phone?: string;
    name?: string;
    code?: string;
}

@Controller('widers')
export class WidersController {
    constructor(
        private readonly widersConfig: WidersConfig,
        private readonly widersService: WidersService,
        private readonly whatsappChannel: WhatsAppChannelService,
        private readonly contactSync: WidersContactSyncService,
        private readonly readiness: WidersReadinessService,
    ) {}

    @Get('health')
    async health(): Promise<WidersHealthStatus> {
        const configured = this.widersService.isReady();
        const ping = configured ? await this.widersService.ping() : { reachable: false };

        return {
            enabled: this.widersConfig.enabled,
            configured,
            apiReachable: ping.reachable,
            frontendUrl: this.widersConfig.frontendUrl ?? null,
            otpMode: this.widersConfig.otpMode,
            templateCount: ping.templateCount,
            message: ping.error,
        };
    }

    @Get('readiness')
    async readinessReport() {
        return this.readiness.evaluate();
    }

    @Get('templates/registry')
    listRegistry() {
        if (process.env.NODE_ENV === 'production') {
            throw new ForbiddenException('Template registry disabled in production');
        }
        return {
            count: TEMPLATE_REGISTRY.length,
            templates: TEMPLATE_REGISTRY.map((t) => ({
                name: t.name,
                language: t.language,
                category: t.category,
                audience: t.audience,
                bodyFields: t.bodyFields,
                buttonSuffixPattern: t.buttonSuffixPattern,
            })),
        };
    }

    /**
     * Dev/staging smoke test — requires WIDERS_ENABLED=true.
     * Uses WIDERS_TEST_PHONE when body.phone omitted.
     */
    @Post('test/otp')
    @HttpCode(HttpStatus.OK)
    async testOtp(@Body() body: TestOtpDto) {
        if (process.env.NODE_ENV === 'production') {
            throw new ForbiddenException('Test endpoint disabled in production');
        }
        if (!this.widersConfig.enabled) {
            return {
                sent: false,
                error: 'Set WIDERS_ENABLED=true to send test messages',
            };
        }

        const phone = body.phone ?? this.widersConfig.testPhone;
        if (!phone) {
            return { sent: false, error: 'Provide phone or set WIDERS_TEST_PHONE' };
        }

        const code = body.code ?? String(Math.floor(100000 + Math.random() * 900000));
        return this.whatsappChannel.sendOtp(
            'customer',
            phone,
            body.name ?? 'اختبار',
            code,
            'ar',
        );
    }

    /**
     * Backfill Widers contacts for existing users missing widersContactId.
     * Dev/staging only — same guard as test/otp.
     */
    @Post('contacts/sync-batch')
    @HttpCode(HttpStatus.OK)
    async syncContactsBatch(@Body() body: { limit?: number }) {
        if (process.env.NODE_ENV === 'production') {
            throw new ForbiddenException('Batch sync disabled in production');
        }

        const limit = Math.min(Math.max(body?.limit ?? 50, 1), 200);
        return this.contactSync.batchSyncMissing(limit);
    }
}
