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
    ],
    controllers: [AppController],
    providers: [],
})
export class AppModule { }

