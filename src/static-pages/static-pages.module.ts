import { Module } from '@nestjs/common';
import { StaticPagesService } from './static-pages.service';
import { StaticPagesController } from './static-pages.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
    imports: [PrismaModule],
    controllers: [StaticPagesController],
    providers: [StaticPagesService],
})
export class StaticPagesModule { }
