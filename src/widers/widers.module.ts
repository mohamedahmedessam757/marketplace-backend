import { Global, Module } from '@nestjs/common';
import { WidersConfig } from './widers.config';
import { WidersService } from './widers.service';
import { WhatsAppChannelService } from './whatsapp-channel.service';
import { WidersContactSyncService } from './widers-contact-sync.service';
import { WidersWebhookController } from './widers-webhook.controller';
import { WidersWebhookService } from './widers-webhook.service';
import { WidersReadinessService } from './widers-readiness.service';
import { WhatsAppMessageLogService } from './whatsapp-message-log.service';
import { WidersController } from './widers.controller';

@Global()
@Module({
    controllers: [WidersController, WidersWebhookController],
    providers: [
        WidersConfig,
        WidersService,
        WhatsAppChannelService,
        WidersContactSyncService,
        WhatsAppMessageLogService,
        WidersWebhookService,
        WidersReadinessService,
    ],
    exports: [
        WidersConfig,
        WidersService,
        WhatsAppChannelService,
        WidersContactSyncService,
        WhatsAppMessageLogService,
        WidersWebhookService,
        WidersReadinessService,
    ],
})
export class WidersModule {}
