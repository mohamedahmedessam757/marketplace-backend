import { forwardRef, Module } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { StripeController } from './stripe.controller';
import { StripeWebhookController } from './stripe-webhook.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { PaymentsModule } from '../payments/payments.module';

@Module({
    imports: [PrismaModule, ConfigModule, forwardRef(() => PaymentsModule)],
    providers: [StripeService],
    controllers: [StripeController, StripeWebhookController],
    exports: [StripeService],
})
export class StripeModule {}
