import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { OrderCleanupService } from './order-cleanup.service';
import { PrismaModule } from '../prisma/prisma.module';
import { OrdersModule } from '../orders/orders.module'; // To access OrderStateMachine
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
    imports: [
        ScheduleModule.forRoot(),
        PrismaModule,
        OrdersModule,
        NotificationsModule
    ],
    providers: [OrderCleanupService],
})
export class SchedulerModule { }
