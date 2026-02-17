import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderStateMachine } from './fsm/order-state-machine.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
// AuditLogsModule is global, so no need to import if @Global() is used, but good practice to verify

@Module({
    imports: [PrismaModule, NotificationsModule],
    controllers: [OrdersController],
    providers: [OrdersService, OrderStateMachine],
    exports: [OrderStateMachine, OrdersService], // Export for Scheduler
})
export class OrdersModule { }
