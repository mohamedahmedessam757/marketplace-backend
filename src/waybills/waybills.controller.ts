import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { WaybillsService } from './waybills.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('waybills')
export class WaybillsController {
    constructor(private readonly waybillsService: WaybillsService) {}

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
