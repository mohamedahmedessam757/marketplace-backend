import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { OrderCleanupService } from './order-cleanup.service';
import { PrismaModule } from '../prisma/prisma.module';
import { OrdersModule } from '../orders/orders.module'; // To access OrderStateMachine
import { NotificationsModule } from '../notifications/notifications.module';
import { EscrowCronService } from './escrow-cron.service';
import { PaymentsModule } from '../payments/payments.module';

@Module({
    imports: [
        ScheduleModule.forRoot(),
        PrismaModule,
        OrdersModule,
        NotificationsModule,
        PaymentsModule
    ],
    providers: [OrderCleanupService, EscrowCronService],
})
export class SchedulerModule { }
