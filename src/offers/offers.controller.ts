import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, Request } from '@nestjs/common';
import { OffersService } from './offers.service';
import { CreateOfferDto } from './dto/create-offer.dto';
import { UpdateOfferDto } from './dto/update-offer.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@Controller('offers')
@UseGuards(JwtAuthGuard)
export class OffersController {
    constructor(private readonly offersService: OffersService) { }

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

    @Delete(':id')
    @UseGuards(RolesGuard)
    @Roles(UserRole.VENDOR)
    deleteByVendor(@Request() req, @Param('id') id: string) {
        return this.offersService.cancelByVendor(req.user.id, id);
    }

    @Get('order/:orderId')
    findByOrder(@Param('orderId') orderId: string) {
        return this.offersService.findByOrder(orderId);
    }

    @Get('my/:orderId')
    @UseGuards(RolesGuard)
    @Roles(UserRole.VENDOR)
    findMyOffers(@Request() req, @Param('orderId') orderId: string) {
        return this.offersService.findMyOffersByOrder(req.user.id, orderId);
    }

    @Patch('admin/:id')
    @UseGuards(RolesGuard)
    @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
    adminUpdate(@Request() req, @Param('id') id: string, @Body() updateOfferDto: UpdateOfferDto) {
        return this.offersService.adminUpdate(req.user.id, id, updateOfferDto);
    }

    @Delete('admin/:id')
    @UseGuards(RolesGuard)
    @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
    adminDelete(@Request() req, @Param('id') id: string) {
        return this.offersService.adminDelete(req.user.id, id);
    }
}

