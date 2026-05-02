import { Module } from '@nestjs/common';
import { VehicleCatalogService } from './vehicle-catalog.service';
import { VehicleCatalogController } from './vehicle-catalog.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [VehicleCatalogController],
  providers: [VehicleCatalogService],
  exports: [VehicleCatalogService],
})
export class VehicleCatalogModule {}
