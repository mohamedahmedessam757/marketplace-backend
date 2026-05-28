import { Controller, Get, Param, UseGuards, Request } from '@nestjs/common';
import { WaybillsService } from './waybills.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ResourceAccessService } from '../common/authorization/resource-access.service';

@Controller('waybills')
export class WaybillsController {
    constructor(
        private readonly waybillsService: WaybillsService,
        private readonly resourceAccess: ResourceAccessService,
    ) {}

    @Get('order/:orderId')
    @UseGuards(JwtAuthGuard)
    async getOrderWaybills(@Request() req, @Param('orderId') orderId: string) {
        await this.resourceAccess.assertUserCanAccessOrder(
            { id: req.user.id, role: req.user.role, storeId: req.user.storeId },
            orderId,
        );
        const result = await this.waybillsService.getWaybillsByOrder(orderId);
        return { success: true, waybills: result.waybills };
    }

    @Get(':id')
    @UseGuards(JwtAuthGuard)
    async getWaybillDetails(@Request() req, @Param('id') id: string) {
        await this.resourceAccess.assertUserCanAccessWaybill(
            { id: req.user.id, role: req.user.role, storeId: req.user.storeId },
            id,
        );
        const waybill = await this.waybillsService.getWaybillById(id);
        return { success: true, waybill };
    }
}
