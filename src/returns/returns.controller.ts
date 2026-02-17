import { Controller, Post, Get, UseGuards, UseInterceptors, UploadedFiles, Body, Request, BadRequestException } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ReturnsService } from './returns.service';

@Controller('returns')
export class ReturnsController {
    constructor(private readonly returnsService: ReturnsService) { }

    @Post('request')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FilesInterceptor('files'))
    async requestReturn(
        @Request() req,
        @UploadedFiles() files: Array<Express.Multer.File>,
        @Body() body: { orderId: string; reason: string; description: string }
    ) {
        if (!body.orderId || !body.reason) {
            throw new BadRequestException('Order ID and Reason are required');
        }

        return this.returnsService.requestReturn(
            req.user.id, // Fixed: User object has 'id', not 'userId'
            body.orderId,
            body.reason,
            body.description,
            files
        );
    }

    @Post('dispute')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FilesInterceptor('files'))
    async escalateDispute(
        @Request() req,
        @UploadedFiles() files: Array<Express.Multer.File>,
        @Body() body: { orderId: string; reason: string; description: string }
    ) {
        if (!body.orderId || !body.reason) {
            throw new BadRequestException('Order ID and Reason are required');
        }

        return this.returnsService.escalateDispute(
            req.user.id, // Fixed: User object has 'id', not 'userId'
            body.orderId,
            body.reason,
            body.description,
            files
        );
    }

    @Get('my-requests')
    @UseGuards(JwtAuthGuard)
    async getUserReturns(@Request() req) {
        return this.returnsService.getUserReturns(req.user.id);
    }
}
