import { Controller, Post, UseInterceptors, UploadedFile, Body, UseGuards, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadsService } from './uploads.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { multerMemoryOptions } from './multer.config';

@Controller('uploads')
export class UploadsController {
    constructor(private readonly uploadsService: UploadsService) { }

    @Post('returns')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FileInterceptor('file', multerMemoryOptions))
    async uploadReturnEvidence(
        @UploadedFile() file: Express.Multer.File,
        @Body('orderId') orderId: string
    ) {
        if (!orderId) throw new BadRequestException('Order ID is required');

        const url = await this.uploadsService.uploadFile(file, `returns/${orderId}`);
        return { url };
    }

    @Post('disputes')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FileInterceptor('file', multerMemoryOptions))
    async uploadDisputeEvidence(
        @UploadedFile() file: Express.Multer.File,
        @Body('orderId') orderId: string
    ) {
        if (!orderId) throw new BadRequestException('Order ID is required');

        const url = await this.uploadsService.uploadFile(file, `disputes/${orderId}`);
        return { url };
    }

    @Post('verification')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FileInterceptor('file', multerMemoryOptions))
    async uploadVerificationDocs(
        @UploadedFile() file: Express.Multer.File,
        @Body('orderId') orderId: string,
        @Body('folder') folder: string
    ) {
        if (!orderId) throw new BadRequestException('Order ID is required');
        const subFolder = folder || 'misc';

        const url = await this.uploadsService.uploadFile(file, `${subFolder}/${orderId}`, 'verification-docs');
        return { url };
    }

    @Post('appeals')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FileInterceptor('file', multerMemoryOptions))
    async uploadAppealEvidence(
        @UploadedFile() file: Express.Multer.File,
        @Body('violationId') violationId: string
    ) {
        if (!violationId) throw new BadRequestException('Violation ID is required');

        const url = await this.uploadsService.uploadFile(file, `appeals/${violationId}`, 'appeals');
        return { url };
    }
}
