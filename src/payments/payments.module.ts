import { forwardRef, Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EscrowService } from './escrow.service';
import { StripeModule } from '../stripe/stripe.module';

@Module({
    imports: [PrismaModule, NotificationsModule, forwardRef(() => StripeModule)],
    controllers: [PaymentsController],
    providers: [PaymentsService, EscrowService],
    exports: [PaymentsService, EscrowService],
})
export class PaymentsModule { }
