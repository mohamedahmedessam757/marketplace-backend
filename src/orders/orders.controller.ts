import { Controller, Get, Post, Body, Patch, Param, UseGuards, Request } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { TransitionOrderDto } from './dto/transition-order.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActorType, UserRole } from '@prisma/client';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
    constructor(private readonly ordersService: OrdersService) { }

    @Post()
    create(@Request() req, @Body() createOrderDto: CreateOrderDto) {
        // Only Customers should create orders ideally, but for now assuming any auth user
        const userId = req.user.id;
        return this.ordersService.create(userId, createOrderDto);
    }

    @Get()
    findAll(@Request() req) {
        return this.ordersService.findAll(req.user);
    }

    @Get(':id')
    findOne(@Param('id') id: string) {
        return this.ordersService.findOne(id);
    }

    @Patch(':id/transition')
    transition(
        @Request() req,
        @Param('id') id: string,
        @Body() transitionDto: TransitionOrderDto
    ) {
        // Map UserRole to ActorType
        let actorType: ActorType = ActorType.SYSTEM;
        const role = req.user.role;

        if (role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN) actorType = ActorType.ADMIN;
        else if (role === UserRole.VENDOR) actorType = ActorType.VENDOR;
        else if (role === UserRole.CUSTOMER) actorType = ActorType.CUSTOMER;

        return this.ordersService.transitionStatus(
            id,
            transitionDto.newStatus,
            { id: req.user.id, type: actorType, name: req.user.email }, // Using email as name fallback
            transitionDto.reason,
            transitionDto.metadata
        );
    }
}
