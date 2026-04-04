import { Module, forwardRef } from '@nestjs/common';
import { LoyaltyService } from './loyalty.service';
import { LoyaltyController } from './loyalty.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { LoyaltyGateway } from './loyalty.gateway';

@Module({
  imports: [PrismaModule],
  controllers: [LoyaltyController],
  providers: [LoyaltyService, LoyaltyGateway],
  exports: [LoyaltyService, LoyaltyGateway],
})
export class LoyaltyModule {}
