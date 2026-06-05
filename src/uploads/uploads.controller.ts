import { Controller, Post, UseInterceptors, UploadedFile, Body, UseGuards, BadRequestException, Request } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadsService } from './uploads.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { multerMemoryOptions } from './multer.config';
import { ResourceAccessService } from '../common/authorization/resource-access.service';

@Controller('uploads')
export class UploadsController {
    constructor(
        private readonly uploadsService: UploadsService,
        private readonly resourceAccess: ResourceAccessService,
    ) { }

    private actor(req: { user: { id: string; role: string; storeId?: string | null } }) {
        return { id: req.user.id, role: req.user.role, storeId: req.user.storeId };
    }

    @Post('returns')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FileInterceptor('file', multerMemoryOptions))
    async uploadReturnEvidence(
        @Request() req,
        @UploadedFile() file: Express.Multer.File,
        @Body('orderId') orderId: string
    ) {
        if (!orderId) throw new BadRequestException('Order ID is required');
        if (!this.isUuid(orderId)) throw new BadRequestException('Invalid order ID');
        await this.resourceAccess.assertUserCanAccessOrder(this.actor(req), orderId);

        const url = await this.uploadsService.uploadFile(file, `returns/${orderId}`);
        return { url };
    }

    @Post('disputes')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FileInterceptor('file', multerMemoryOptions))
    async uploadDisputeEvidence(
        @Request() req,
        @UploadedFile() file: Express.Multer.File,
        @Body('orderId') orderId: string
    ) {
        if (!orderId) throw new BadRequestException('Order ID is required');
        if (!this.isUuid(orderId)) throw new BadRequestException('Invalid order ID');
        await this.resourceAccess.assertUserCanAccessOrder(this.actor(req), orderId);

        const url = await this.uploadsService.uploadFile(file, `disputes/${orderId}`);
        return { url };
    }

    /** Support ticket attachments (customer / merchant) — not tied to an order UUID */
    @Post('support')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FileInterceptor('file', multerMemoryOptions))
    async uploadSupportAttachment(
        @Request() req,
        @UploadedFile() file: Express.Multer.File,
        @Body('folder') folder: string,
    ) {
        if (!file) throw new BadRequestException('File is required');
        const allowed = new Set(['customer-tickets', 'merchant-tickets']);
        const safeFolder = allowed.has(folder) ? folder : 'support';
        const url = await this.uploadsService.uploadFile(
            file,
            `${safeFolder}/${req.user.id}`,
            'support-files',
        );
        return { url };
    }

    @Post('verification')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FileInterceptor('file', multerMemoryOptions))
    async uploadVerificationDocs(
        @Request() req,
        @UploadedFile() file: Express.Multer.File,
        @Body('orderId') orderId: string,
        @Body('folder') folder: string
    ) {
        if (!orderId) throw new BadRequestException('Order ID is required');
        if (!this.isUuid(orderId)) {
            throw new BadRequestException('Invalid order ID');
        }
        await this.resourceAccess.assertUserCanAccessOrder(this.actor(req), orderId);
        const subFolder = folder || 'misc';

        const url = await this.uploadsService.uploadFile(
            file,
            `${subFolder}/${orderId}`,
            'verification-docs',
            'verification',
        );
        return { url };
    }

    @Post('avatar')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FileInterceptor('file', multerMemoryOptions))
    async uploadAvatar(
        @Request() req,
        @UploadedFile() file: Express.Multer.File,
    ) {
        if (!file) throw new BadRequestException('File is required');
        const url = await this.uploadsService.uploadFile(
            file,
            `avatars/${req.user.id}`,
            'marketplace-uploads',
            'avatar',
        );
        return { url };
    }

    @Post('chat')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FileInterceptor('file', multerMemoryOptions))
    async uploadChatMedia(
        @Request() req,
        @UploadedFile() file: Express.Multer.File,
        @Body('chatId') chatId: string,
    ) {
        if (!chatId) throw new BadRequestException('Chat ID is required');
        await this.resourceAccess.assertUserCanAccessChat(this.actor(req), chatId);
        const url = await this.uploadsService.uploadFile(file, `chat/${chatId}`, 'chat_media');
        return { url };
    }

    @Post('order-draft')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FileInterceptor('file', multerMemoryOptions))
    async uploadOrderDraftMedia(
        @Request() req,
        @UploadedFile() file: Express.Multer.File,
        @Body('folder') folder: string,
    ) {
        if (!folder) throw new BadRequestException('Folder is required');
        const safeFolder = folder.replace(/[^a-zA-Z0-9/_-]/g, '').slice(0, 120);
        const url = await this.uploadsService.uploadFile(
            file,
            `order-draft/${req.user.id}/${safeFolder}`,
            'marketplace-uploads',
        );
        return { url };
    }

    @Post('appeals')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FileInterceptor('file', multerMemoryOptions))
    async uploadAppealEvidence(
        @Request() req,
        @UploadedFile() file: Express.Multer.File,
        @Body('violationId') violationId: string
    ) {
        if (!violationId) throw new BadRequestException('Violation ID is required');
        await this.resourceAccess.assertUserCanAccessViolation(this.actor(req), violationId);

        const url = await this.uploadsService.uploadFile(file, `appeals/${violationId}`, 'appeals');
        return { url };
    }

    private isUuid(value: string): boolean {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            value.trim(),
        );
    }
}
