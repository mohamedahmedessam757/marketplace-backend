import { Controller, Post, UseInterceptors, UploadedFile, Body, UseGuards, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadsService } from './uploads.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('uploads')
export class UploadsController {
    constructor(private readonly uploadsService: UploadsService) { }

    @Post('returns')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FileInterceptor('file'))
    async uploadReturnEvidence(
        @UploadedFile() file: Express.Multer.File,
        @Body('orderId') orderId: string
    ) {
        if (!orderId) throw new BadRequestException('Order ID is required');

        // Path: returns/{orderId}/filename
        const url = await this.uploadsService.uploadFile(file, `returns/${orderId}`);
        return { url };
    }

    @Post('disputes')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FileInterceptor('file'))
    async uploadDisputeEvidence(
        @UploadedFile() file: Express.Multer.File,
        @Body('orderId') orderId: string
    ) {
        if (!orderId) throw new BadRequestException('Order ID is required');

        // Path: disputes/{orderId}/filename
        const url = await this.uploadsService.uploadFile(file, `disputes/${orderId}`);
        return { url };
    }
}
