import { Module } from '@nestjs/common';
import { OffersService } from './offers.service';
import { OffersController } from './offers.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { StoresModule } from '../stores/stores.module';

@Module({
    imports: [PrismaModule, StoresModule],
    controllers: [OffersController],
    providers: [OffersService],
    exports: [OffersService],
})
export class OffersModule { }
