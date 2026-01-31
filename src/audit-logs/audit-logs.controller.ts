import { Controller, Get, Param, UseGuards, Query } from '@nestjs/common';
import { AuditLogsService } from './audit-logs.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
// import { RolesGuard } from '../common/guards/roles.guard'; // Later
// import { Roles } from '../common/decorators/roles.decorator';

@Controller('audit-logs')
@UseGuards(JwtAuthGuard)
export class AuditLogsController {
    constructor(private readonly auditLogsService: AuditLogsService) { }

    @Get()
    findAll(@Query('orderId') orderId?: string) {
        if (orderId) {
            return this.auditLogsService.findByOrder(orderId);
        }
        return this.auditLogsService.findAll();
    }

    @Get('order/:orderId')
    findByOrder(@Param('orderId') orderId: string) {
        return this.auditLogsService.findByOrder(orderId);
    }
}
