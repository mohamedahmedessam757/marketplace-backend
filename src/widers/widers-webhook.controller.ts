import {
    Controller,
    Get,
    Post,
    Query,
    Body,
    Req,
    Res,
    HttpCode,
    HttpStatus,
    Logger,
    ForbiddenException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { WidersWebhookService } from './widers-webhook.service';
import { WhatsAppMessageLogService } from './whatsapp-message-log.service';

@SkipThrottle()
@Controller('widers/webhook')
export class WidersWebhookController {
    private readonly logger = new Logger(WidersWebhookController.name);

    constructor(
        private readonly webhookService: WidersWebhookService,
        private readonly messageLog: WhatsAppMessageLogService,
    ) {}

    /** Dev/staging — recent WhatsApp message logs */
    @Get('logs')
    async listLogs(@Query('limit') limit?: string) {
        if (process.env.NODE_ENV === 'production') {
            throw new ForbiddenException('Logs endpoint disabled in production');
        }
        const n = limit ? Number(limit) : 50;
        return this.messageLog.listRecent(Number.isFinite(n) ? n : 50);
    }

    /**
     * Meta/Widers webhook verification (GET challenge).
     * Configure verify token = WIDERS_WEBHOOK_SECRET in Widers/Meta dashboard.
     */
    @Get()
    verify(
        @Query('hub.mode') mode: string,
        @Query('hub.verify_token') token: string,
        @Query('hub.challenge') challenge: string,
        @Res() res: Response,
    ) {
        try {
            const answer = this.webhookService.verifyMetaChallenge(mode, token, challenge);
            return res.status(200).send(answer);
        } catch (err) {
            this.logger.warn(
                `Webhook verify failed: ${err instanceof Error ? err.message : err}`,
            );
            return res.sendStatus(403);
        }
    }

    /**
     * Delivery status + inbound message callbacks.
     * Auth: ?token=WIDERS_WEBHOOK_SECRET or header x-widers-token
     */
    @Post()
    @HttpCode(HttpStatus.OK)
    async receive(
        @Req() req: Request,
        @Query('token') queryToken: string | undefined,
        @Body() body: Record<string, unknown>,
        @Res() res: Response,
    ) {
        try {
            const headerToken = req.headers['x-widers-token'];
            this.webhookService.assertAuthorized(
                queryToken,
                typeof headerToken === 'string' ? headerToken : undefined,
            );

            const result = await this.webhookService.processWebhook(body ?? {});
            return res.json(result);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error(`Widers webhook processing failed: ${message}`);
            if (message.includes('not configured') || message.includes('Invalid')) {
                return res.status(403).json({ error: message });
            }
            return res.status(500).json({ error: 'webhook_processing_failed' });
        }
    }

}
