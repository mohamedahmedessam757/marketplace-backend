import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderStateMachine } from './fsm/order-state-machine.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ChatModule } from '../chat/chat.module';
import { ShipmentsModule } from '../shipments/shipments.module';

@Module({
    imports: [PrismaModule, NotificationsModule, ChatModule, ShipmentsModule],
    controllers: [OrdersController],
    providers: [OrdersService, OrderStateMachine],
    exports: [OrderStateMachine, OrdersService], // Export for Scheduler
})
export class OrdersModule { }
