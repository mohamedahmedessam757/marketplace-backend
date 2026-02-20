import { Controller, Get, Post, Body, Param, UseGuards, Request } from '@nestjs/common';
import { SupportService } from './support.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('support')
export class SupportController {
    constructor(private readonly supportService: SupportService) { }

    @Post('tickets')
    @UseGuards(JwtAuthGuard)
    create(@Body() createTicketDto: CreateTicketDto, @Request() req) {
        // Mock user for now if auth not fully inspected, but typically req.user
        const userId = req.user?.id || createTicketDto.userId; // Fallback for testing
        console.log('Create Ticket Request:', { body: createTicketDto, userId, user: req.user });
        if (!userId) {
            console.error('UserId is missing in request. Req User:', req.user, 'DTO UserId:', createTicketDto.userId);
            // Verify if we can extract from token manually if guard failed
        }
        return this.supportService.create(userId, createTicketDto);
    }

    @Get('tickets')
    findAll(@Request() req) {
        const userId = req.query?.userId || req.user?.id;
        const role = req.query?.role || req.user?.role;
        return this.supportService.findAll(userId, role);
    }

    @Get('tickets/:id')
    findOne(@Param('id') id: string) {
        return this.supportService.findOne(id);
    }

    @Post('tickets/:id/messages')
    addMessage(
        @Param('id') id: string,
        @Body() body: { text: string; senderId: string; role: string; mediaUrl?: string; mediaType?: string }
    ) {
        return this.supportService.addMessage(id, body.senderId, body.role, body.text, body.mediaUrl, body.mediaType);
    }
}
