import { Controller, Post, Get, Param, UseGuards, Request } from '@nestjs/common';
import { WaybillsService } from './waybills.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';

@Controller('waybills')
export class WaybillsController {
    constructor(private readonly waybillsService: WaybillsService) {}

    // Admin issues waybills for a successfully verified order
    @Post('issue/:orderId')
    @UseGuards(JwtAuthGuard, PermissionsGuard)
    @Permissions('shipping', 'edit')
    async issueWaybills(
        @Param('orderId') orderId: string,
        @Request() req
    ) {
        const adminId = req.user.id;
        const waybills = await this.waybillsService.issueWaybillsForOrder(orderId, adminId);
        return { success: true, waybills };
    }

    // Get all waybills for a specific order (Accessible to participants)
    @Get('order/:orderId')
    @UseGuards(JwtAuthGuard)
    async getOrderWaybills(@Param('orderId') orderId: string) {
        // Simple implementation: In a real app we'd verify the user is admin, the buyer, or the seller
        const result = await this.waybillsService.getWaybillsByOrder(orderId);
        return { success: true, waybills: result.waybills };
    }

    // Get a specific waybill definition
    @Get(':id')
    @UseGuards(JwtAuthGuard)
    async getWaybillDetails(@Param('id') id: string) {
        const waybill = await this.waybillsService.getWaybillById(id);
        return { success: true, waybill };
    }
}
