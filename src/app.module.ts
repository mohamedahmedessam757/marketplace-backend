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
import { PaymentsModule } from './payments/payments.module';
import { CardsModule } from './cards/cards.module';
import { InvoicesModule } from './invoices/invoices.module';
import { ContractsModule } from './contracts/contracts.module';
import { WaybillsModule } from './waybills/waybills.module';
import { ShipmentsModule } from './shipments/shipments.module';
import { ReviewsModule } from './reviews/reviews.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { MerchantPerformanceModule } from './merchant-performance/merchant-performance.module';
import { StripeModule } from './stripe/stripe.module';
import { ViolationsModule } from './violations/violations.module';
import { PlatformSettingsModule } from './platform-settings/platform-settings.module';
import { VehicleCatalogModule } from './vehicle-catalog/vehicle-catalog.module';
import { AdminPermissionsModule } from './admin-permissions/admin-permissions.module';
import { APP_GUARD } from '@nestjs/core';
import { MaintenanceGuard } from './platform-settings/maintenance.guard';

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
        PaymentsModule,
        CardsModule,
        InvoicesModule,
        ContractsModule,
        WaybillsModule,
        ShipmentsModule,
        ReviewsModule,
        LoyaltyModule,
        MerchantPerformanceModule,
        StripeModule,
        ViolationsModule,
        PlatformSettingsModule,
        VehicleCatalogModule,
        AdminPermissionsModule,
    ],
    controllers: [AppController],
    providers: [
        {
            provide: APP_GUARD,
            useClass: MaintenanceGuard,
        },
    ],
})
export class AppModule { }
