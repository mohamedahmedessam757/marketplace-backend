import { Controller, Get, Post, Delete, Patch, Body, Param, UseGuards, Request } from '@nestjs/common';
import { CardsService } from './cards.service';
import { CreateCardDto } from './dto/create-card.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('cards')
@UseGuards(JwtAuthGuard)
export class CardsController {
    constructor(private readonly cardsService: CardsService) { }

    @Get()
    getUserCards(@Request() req) {
        return this.cardsService.getUserCards(req.user.id);
    }

    @Post()
    addCard(@Request() req, @Body() dto: CreateCardDto) {
        return this.cardsService.addCard(req.user.id, dto);
    }

    @Delete(':id')
    deleteCard(@Request() req, @Param('id') id: string) {
        return this.cardsService.deleteCard(req.user.id, id);
    }

    @Patch(':id/default')
    setDefaultCard(@Request() req, @Param('id') id: string) {
        return this.cardsService.setDefaultCard(req.user.id, id);
    }
}
