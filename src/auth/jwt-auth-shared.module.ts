import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { jwtModuleAsyncOptions } from './jwt-module.config';

@Module({
  imports: [jwtModuleAsyncOptions],
  exports: [JwtModule],
})
export class JwtAuthSharedModule {}
