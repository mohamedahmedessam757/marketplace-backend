import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderStateMachine } from './fsm/order-state-machine.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ChatModule } from '../chat/chat.module';
import { ShipmentsModule } from '../shipments/shipments.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { WarrantySchedulerService } from './warranty-scheduler.service';

@Module({
    imports: [PrismaModule, NotificationsModule, ChatModule, ShipmentsModule, LoyaltyModule],
    controllers: [OrdersController],
    providers: [OrdersService, OrderStateMachine, WarrantySchedulerService],
    exports: [OrderStateMachine, OrdersService], // Export for Scheduler
})
export class OrdersModule { }
