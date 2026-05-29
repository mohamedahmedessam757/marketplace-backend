import { Module, forwardRef } from '@nestjs/common';
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
import { WaybillsModule } from '../waybills/waybills.module';
import { VerificationTasksModule } from '../verification-tasks/verification-tasks.module';

import { ExcelService } from './excel.service';

import { ShippingAutomationService } from './shipping-automation.service';
import { OfferFulfillmentService } from './offer-fulfillment.service';

@Module({
    imports: [PrismaModule, NotificationsModule, ChatModule, ShipmentsModule, LoyaltyModule, UsersModule, WaybillsModule, forwardRef(() => VerificationTasksModule)],
    controllers: [OrdersController],
    providers: [OrdersService, OrderStateMachine, WarrantySchedulerService, ExcelService, ShippingAutomationService, OfferFulfillmentService],
    exports: [OrderStateMachine, OrdersService, ExcelService, OfferFulfillmentService],
})
export class OrdersModule { }
