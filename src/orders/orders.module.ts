import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderStateMachine } from './fsm/order-state-machine.service';
import { PrismaModule } from '../prisma/prisma.module';
// AuditLogsModule is global, so no need to import if @Global() is used, but good practice to verify

@Module({
    imports: [PrismaModule],
    controllers: [OrdersController],
    providers: [OrdersService, OrderStateMachine],
})
export class OrdersModule { }
