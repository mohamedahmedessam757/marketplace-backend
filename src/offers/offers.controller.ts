import { Controller, Get, Post, Body, Param, UseGuards, Request } from '@nestjs/common';
import { OffersService } from './offers.service';
import { CreateOfferDto } from './dto/create-offer.dto';
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
    @Roles(UserRole.VENDOR) // Only Vendors create offers
    create(@Request() req, @Body() createOfferDto: CreateOfferDto) {
        return this.offersService.create(req.user.id, createOfferDto);
    }

    @Get('order/:orderId')
    findByOrder(@Param('orderId') orderId: string) {
        return this.offersService.findByOrder(orderId);
    }
}
