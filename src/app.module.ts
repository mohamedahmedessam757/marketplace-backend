import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuditLogsModule } from './audit-logs/audit-logs.module';
import { OrdersModule } from './orders/orders.module';
import { StoresModule } from './stores/stores.module';
import { StaticPagesModule } from './static-pages/static-pages.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { OffersModule } from './offers/offers.module';
import { AppController } from './app.controller';
import { NotificationsModule } from './notifications/notifications.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { UploadsModule } from './uploads/uploads.module';
import { ReturnsModule } from './returns/returns.module';
import { ChatModule } from './chat/chat.module';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
        }),
        UsersModule,
        AuthModule,
        PrismaModule,
        AuditLogsModule,
        OrdersModule,
        StoresModule,
        StaticPagesModule,
        DashboardModule,
        OffersModule,
        NotificationsModule,
        SchedulerModule,
        UploadsModule,
        ReturnsModule,
        ChatModule,
    ],
    controllers: [AppController],
    providers: [],
})
export class AppModule { }

