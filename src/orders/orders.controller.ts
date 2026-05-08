import { Controller, Get, Post, Body, Patch, Param, UseGuards, Request, ForbiddenException, Query, Delete, Res } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { TransitionOrderDto } from './dto/transition-order.dto';
import { FindAllOrdersDto } from './dto/find-all-orders.dto';
import { ReviewVerificationDto } from './dto/review-verification.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { ActorType, UserRole } from '@prisma/client';

import { ExcelService } from './excel.service';
import { Response } from 'express';

@Controller('orders')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OrdersController {
    constructor(
        private readonly ordersService: OrdersService,
        private readonly excelService: ExcelService
    ) { }

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

    @Get('admin/shipping-carts')
    @Permissions('shipping-carts', 'view')
    getAdminShippingCarts(@Request() req) {
        return this.ordersService.getAdminShippingCarts();
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
    requestShipping(@Request() req, @Body() data: { orderIds?: string[], offerIds?: string[], customerId?: string }) {
        const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN';
        const targetCustomerId = isAdmin && data.customerId ? data.customerId : req.user.id;
        
        // Pass admin actor if the requester is an admin
        const adminActor = isAdmin ? { id: req.user.id, type: ActorType.ADMIN, name: req.user.email } : undefined;
        
        return this.ordersService.requestShipping(targetCustomerId, data.orderIds, data.offerIds, false, adminActor);
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

    @Get(':id/export-excel')
    async exportInvoice(@Request() req, @Param('id') id: string, @Res() res: Response) {
        return this.excelService.exportInvoice(id, req.user, res);
    }

    @Get(':id/waybills/export-excel')
    async exportWaybills(
        @Request() req, 
        @Param('id') id: string, 
        @Res() res: Response,
        @Query('shipmentId') shipmentId?: string
    ) {
        return this.excelService.exportWaybill(id, req.user, res, shipmentId);
    }
}
