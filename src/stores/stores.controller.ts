import { Controller, Get, Post, Patch, Body, UseGuards, Request, Param } from '@nestjs/common';
import { StoresService } from './stores.service';
import { UploadStoreDocumentDto } from './dto/upload-store-document.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole, StoreStatus } from '@prisma/client';

@Controller('stores')
@UseGuards(JwtAuthGuard)
export class StoresController {
    constructor(private readonly storesService: StoresService) { }

    @Get('me')
    findMyStore(@Request() req) {
        return this.storesService.findMyStore(req.user.id);
    }

    @Post('onboarding/documents')
    uploadDocument(@Request() req, @Body() dto: UploadStoreDocumentDto) {
        return this.storesService.uploadDocument(req.user.id, dto);
    }
    @Get()
    @UseGuards(RolesGuard)
    @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
    findAll() {
        return this.storesService.findAll();
    }

    @Get(':id')
    @UseGuards(RolesGuard)
    @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
    findOne(@Param('id') id: string) {
        return this.storesService.findOne(id);
    }

    @Patch(':id/status')
    @UseGuards(RolesGuard)
    @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
    updateStatus(@Param('id') id: string, @Body('status') status: StoreStatus) {
        return this.storesService.updateStatus(id, status);
    }

    @Patch(':id/documents/:docType/status')
    @UseGuards(RolesGuard)
    @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
    updateDocumentStatus(
        @Param('id') id: string,
        @Param('docType') docType: string,
        @Body() body: { status: string, reason?: string }
    ) {
        return this.storesService.updateDocumentStatus(id, docType, body.status, body.reason);
    }
}
