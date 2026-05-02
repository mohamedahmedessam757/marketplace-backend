import { Controller, Get, Post, Body, Patch, Param, UseGuards, Request, ForbiddenException, Query, Delete } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { TransitionOrderDto } from './dto/transition-order.dto';
import { FindAllOrdersDto } from './dto/find-all-orders.dto';
import { ReviewVerificationDto } from './dto/review-verification.dto';
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
    async findAll(@Request() req, @Query() query: FindAllOrdersDto) {
        const result = await this.ordersService.findAll(req.user, query);
        
        // For vendors, include their storeId so frontend can reliably identify own offers
        if (req.user.role === 'VENDOR' && req.user.storeId) {
            return { ...result, requestingStoreId: req.user.storeId };
        }
        return result;
    }

    @Get('delivered')
    getDeliveredOrders(@Request() req) {
        return this.ordersService.getDeliveredOrders(req.user.id);
    }

    @Get('assembly-cart')
    getAssemblyCart(@Request() req) {
        return this.ordersService.getAssemblyCart(req.user.id);
    }

    @Get('merchant-assembly-cart')
    getMerchantAssemblyCart(@Request() req) {
        return this.ordersService.getMerchantAssemblyCart(req.user.id, req.user.storeId);
    }

    @Post('request-shipping')
    requestShipping(@Request() req, @Body() data: { orderIds: string[] }) {
        return this.ordersService.requestShipping(req.user.id, data.orderIds);
    }

    @Patch(':id/merchant-request-shipping')
    requestShippingByMerchant(@Request() req, @Param('id') orderId: string) {
        const storeId = req.user.storeId;
        if (!storeId) throw new ForbiddenException('Only verified merchants can request shipping.');
        return this.ordersService.requestShippingByMerchant(orderId, storeId, req.user.id);
    }

    @Get(':id')
    findOne(@Request() req, @Param('id') id: string) {
        return this.ordersService.findOneWithContext(id, req.user);
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
    @Post(':id/offer/:offerId/accept')
    acceptOffer(
        @Request() req,
        @Param('id') orderId: string,
        @Param('offerId') offerId: string
    ) {
        return this.ordersService.acceptOffer(orderId, offerId, req.user.id);
    }

    @Post(':id/part/:partId/offer/:offerId/accept')
    acceptOfferForPart(
        @Request() req,
        @Param('id') orderId: string,
        @Param('partId') partId: string,
        @Param('offerId') offerId: string
    ) {
        return this.ordersService.acceptOfferForPart(orderId, partId, offerId, req.user.id);
    }

    @Post(':id/offer/:offerId/reject')
    rejectOffer(
        @Request() req,
        @Param('id') orderId: string,
        @Param('offerId') offerId: string,
        @Body('reason') reason: string,
        @Body('customReason') customReason?: string
    ) {
        return this.ordersService.rejectOffer(orderId, offerId, req.user.id, reason, customReason);
    }

    @Patch(':id/checkout-data')
    saveCheckoutData(
        @Request() req,
        @Param('id') orderId: string,
        @Body() data: any
    ) {
        return this.ordersService.saveCheckoutData(orderId, req.user.id, data);
    }

    @Patch('admin/:id/notes')
    updateAdminNotes(
        @Request() req,
        @Param('id') orderId: string,
        @Body('notes') notes: string
    ) {
        return this.ordersService.updateAdminNotes(orderId, notes, req.user);
    }

    @Patch(':id/prepare')
    markAsPrepared(
        @Request() req,
        @Param('id') orderId: string,
    ) {
        const storeId = req.user.storeId;
        if (!storeId) {
            throw new ForbiddenException('Only verified merchants can mark orders as prepared.');
        }
        return this.ordersService.markAsPrepared(orderId, storeId);
    }

    @Post(':id/verification')
    submitVerification(
        @Request() req,
        @Param('id') orderId: string,
        @Body() data: any
    ) {
        const storeId = req.user.storeId;
        if (!storeId) throw new ForbiddenException('Only verified merchants can submit verification docs.');
        return this.ordersService.submitVerification(orderId, storeId, data);
    }
    @Patch(':id/verification/review')
    adminReviewVerification(
        @Request() req,
        @Param('id') orderId: string,
        @Body() data: ReviewVerificationDto
    ) {
        if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
            throw new ForbiddenException('Only admins can review verification docs.');
        }
        return this.ordersService.adminReviewVerification(orderId, req.user.id, data);
    }

    @Post(':id/verification/correction')
    submitCorrectionVerification(
        @Request() req,
        @Param('id') orderId: string,
        @Body() data: any
    ) {
        const storeId = req.user.storeId;
        if (!storeId) throw new ForbiddenException('Only verified merchants can submit corrections.');
        return this.ordersService.submitCorrectionVerification(orderId, storeId, data);
    }

    @Post(':id/deliver')
    confirmDelivery(
        @Request() req,
        @Param('id') id: string,
        @Body('customerNote') customerNote?: string
    ) {
        return this.ordersService.confirmDelivery(id, req.user.id, customerNote);
    }
    @Delete(':id')
    delete(@Request() req, @Param('id') id: string) {
        return this.ordersService.deleteOrder(id, req.user.id);
    }

    @Patch(':id/renew')
    renew(@Request() req, @Param('id') id: string) {
        return this.ordersService.renewOrder(id, req.user.id);
    }
}
