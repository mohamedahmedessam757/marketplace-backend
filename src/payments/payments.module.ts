import { forwardRef, Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EscrowService } from './escrow.service';
import { StripeModule } from '../stripe/stripe.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { OrdersModule } from '../orders/orders.module';
import { CardsModule } from '../cards/cards.module';

@Module({
    imports: [
        PrismaModule,
        NotificationsModule,
        AuditLogsModule,
        forwardRef(() => StripeModule),
        forwardRef(() => OrdersModule),
        CardsModule,
    ],
    controllers: [PaymentsController],
    providers: [PaymentsService, EscrowService],
    exports: [PaymentsService, EscrowService],
})
export class PaymentsModule { }
