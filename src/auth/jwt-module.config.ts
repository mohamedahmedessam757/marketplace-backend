import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

/** Shared dynamic module ref — NestJS 11 requires same object across imports. */
export const jwtModuleAsyncOptions = JwtModule.registerAsync({
  imports: [ConfigModule],
  useFactory: (config: ConfigService) => ({
    secret: config.get<string>('JWT_SECRET'),
    signOptions: { expiresIn: (config.get<string>('JWT_EXPIRES_IN') || '1d') as any },
  }),
  inject: [ConfigService],
});
