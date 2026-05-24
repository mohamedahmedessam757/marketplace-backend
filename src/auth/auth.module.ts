import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { RecoveryController } from './recovery.controller';
import { UsersModule } from '../users/users.module';
import { RecoveryService } from './recovery.service';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './strategies/jwt.strategy';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';
import { jwtModuleAsyncOptions } from './jwt-module.config';

@Module({
  imports: [
    UsersModule,
    NotificationsModule,
    AuditLogsModule,
    PlatformSettingsModule,
    PassportModule,
    jwtModuleAsyncOptions,
  ],
  controllers: [AuthController, RecoveryController],
  providers: [AuthService, RecoveryService, JwtStrategy],
  exports: [AuthService, RecoveryService],
})
export class AuthModule { }
