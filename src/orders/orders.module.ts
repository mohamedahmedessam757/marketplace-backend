import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderStateMachine } from './fsm/order-state-machine.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ChatModule } from '../chat/chat.module';
import { ShipmentsModule } from '../shipments/shipments.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { UsersModule } from '../users/users.module';
import { WarrantySchedulerService } from './warranty-scheduler.service';

import { ExcelService } from './excel.service';

import { ShippingAutomationService } from './shipping-automation.service';

@Module({
    imports: [PrismaModule, NotificationsModule, ChatModule, ShipmentsModule, LoyaltyModule, UsersModule],
    controllers: [OrdersController],
    providers: [OrdersService, OrderStateMachine, WarrantySchedulerService, ExcelService, ShippingAutomationService],
    exports: [OrderStateMachine, OrdersService, ExcelService], // Export for Scheduler and others
})
export class OrdersModule { }
