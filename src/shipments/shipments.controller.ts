import { Controller, Get, Post, Body, Patch, Param, UseGuards, Request } from '@nestjs/common';
import { ShipmentsService } from './shipments.service';
import { CreateShipmentDto } from './dto/create-shipment.dto';
import { UpdateShipmentStatusDto } from './dto/update-shipment-status.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('shipments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ShipmentsController {
    constructor(private readonly shipmentsService: ShipmentsService) {}

    @Roles('ADMIN', 'SUPER_ADMIN')
    @Get()
    findAll() {
        return this.shipmentsService.findAll();
    }

    @Get('my')
    findMyShipments(@Request() req) {
        return this.shipmentsService.findMyShipments(req.user.id, req.user.role);
    }

    @Get('order/:orderId')
    getByOrderId(@Param('orderId') orderId: string) {
        return this.shipmentsService.getByOrderId(orderId);
    }

    @Get(':id/logs')
    getLogs(@Param('id') id: string) {
        return this.shipmentsService.getLogs(id);
    }

    @Roles('ADMIN', 'SUPER_ADMIN')
    @Post()
    create(@Body() createShipmentDto: CreateShipmentDto, @Request() req) {
        return this.shipmentsService.create(createShipmentDto, req.user.id);
    }

    @Roles('ADMIN', 'SUPER_ADMIN')
    @Patch(':id/status')
    updateStatus(
        @Param('id') id: string,
        @Body() updateShipmentDto: UpdateShipmentStatusDto,
        @Request() req
    ) {
        return this.shipmentsService.updateStatus(id, req.user.id, updateShipmentDto);
    }
}
