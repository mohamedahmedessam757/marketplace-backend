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
    findAll(
        @Query('orderId') orderId?: string,
        @Query('cursor') cursor?: string,
        @Query('limit') limit?: string,
    ) {
        if (orderId) {
            return this.auditLogsService.findByOrder(orderId);
        }
        const parsedLimit = limit ? parseInt(limit, 10) : 25;
        return this.auditLogsService.findAll(cursor, parsedLimit);
    }

    @Get('order/:orderId')
    findByOrder(@Param('orderId') orderId: string) {
        return this.auditLogsService.findByOrder(orderId);
    }

    @Get('action/:action')
    findByAction(@Param('action') action: string) {
        return this.auditLogsService.findByAction(action);
    }
}
