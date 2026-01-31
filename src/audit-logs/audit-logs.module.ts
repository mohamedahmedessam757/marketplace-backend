import { Module, Global } from '@nestjs/common';
import { AuditLogsService } from './audit-logs.service';
import { AuditLogsController } from './audit-logs.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Global() // Make it global so OrdersModule can use it easily
@Module({
    imports: [PrismaModule],
    controllers: [AuditLogsController],
    providers: [AuditLogsService],
    exports: [AuditLogsService],
})
export class AuditLogsModule { }
