import { Controller, Get, Post, Body, Patch, Param, UseGuards, Request } from '@nestjs/common';
import { ShipmentsService } from './shipments.service';
import { CreateShipmentDto } from './dto/create-shipment.dto';
import { UpdateShipmentStatusDto } from './dto/update-shipment-status.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';

@Controller('shipments')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ShipmentsController {
    constructor(private readonly shipmentsService: ShipmentsService) {}

    @Permissions('shipping', 'view')
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

    @Permissions('shipping', 'edit')
    @Post()
    create(@Body() createShipmentDto: CreateShipmentDto, @Request() req) {
        return this.shipmentsService.create(createShipmentDto, req.user.id);
    }

    @Permissions('shipping', 'edit')
    @Patch(':id/status')
    updateStatus(
        @Param('id') id: string,
        @Body() updateShipmentDto: UpdateShipmentStatusDto,
        @Request() req
    ) {
        return this.shipmentsService.updateStatus(id, req.user.id, updateShipmentDto);
    }
}
