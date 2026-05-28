import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, Request, ForbiddenException } from '@nestjs/common';
import { OffersService } from './offers.service';
import { CreateOfferDto } from './dto/create-offer.dto';
import { UpdateOfferDto } from './dto/update-offer.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { UserRole } from '@prisma/client';
import { ResourceAccessService } from '../common/authorization/resource-access.service';
import { isAdminRole } from '../common/user-sanitizer';

@Controller('offers')
@UseGuards(JwtAuthGuard)
export class OffersController {
    constructor(
        private readonly offersService: OffersService,
        private readonly resourceAccess: ResourceAccessService,
    ) { }

    @Post()
    @UseGuards(RolesGuard)
    @Roles(UserRole.VENDOR)
    create(@Request() req, @Body() createOfferDto: CreateOfferDto) {
        return this.offersService.create(req.user.id, createOfferDto);
    }

    @Patch(':id')
    @UseGuards(RolesGuard)
    @Roles(UserRole.VENDOR)
    update(@Request() req, @Param('id') id: string, @Body() updateOfferDto: UpdateOfferDto) {
        return this.offersService.update(req.user.id, id, updateOfferDto);
    }

    @Post(':id/withdraw')
    @UseGuards(RolesGuard)
    @Roles(UserRole.VENDOR)
    withdraw(@Request() req, @Param('id') id: string) {
        return this.offersService.withdraw(req.user.id, id);
    }

    @Post(':id/voluntary-withdraw')
    @UseGuards(RolesGuard)
    @Roles(UserRole.VENDOR)
    voluntaryWithdraw(@Request() req, @Param('id') id: string) {
        return this.offersService.voluntaryWithdraw(req.user.id, id);
    }

    @Delete(':id')
    @UseGuards(RolesGuard)
    @Roles(UserRole.VENDOR)
    deleteByVendor(@Request() req, @Param('id') id: string) {
        return this.offersService.cancelByVendor(req.user.id, id);
    }

    @Get('order/:orderId')
    async findByOrder(@Request() req, @Param('orderId') orderId: string) {
        const actor = { id: req.user.id, role: req.user.role, storeId: req.user.storeId };
        if (isAdminRole(req.user.role)) {
            return this.offersService.findByOrder(orderId);
        }
        if (req.user.role === 'CUSTOMER') {
            await this.resourceAccess.assertUserCanAccessOrder(actor, orderId);
            return this.offersService.findByOrder(orderId);
        }
        if (req.user.role === 'VENDOR') {
            return this.offersService.findMyOffersByOrder(req.user.id, orderId);
        }
        throw new ForbiddenException('Access denied');
    }

    @Get('my/:orderId')
    @UseGuards(RolesGuard)
    @Roles(UserRole.VENDOR)
    findMyOffers(@Request() req, @Param('orderId') orderId: string) {
        return this.offersService.findMyOffersByOrder(req.user.id, orderId);
    }

    @Patch('admin/:id')
    @UseGuards(PermissionsGuard)
    @Permissions('offers', 'edit')
    adminUpdate(@Request() req, @Param('id') id: string, @Body() updateOfferDto: UpdateOfferDto) {
        return this.offersService.adminUpdate(req.user.id, id, updateOfferDto);
    }

    @Delete('admin/:id')
    @UseGuards(PermissionsGuard)
    @Permissions('offers', 'edit')
    adminDelete(@Request() req, @Param('id') id: string) {
        return this.offersService.adminDelete(req.user.id, id);
    }
}

