import { Controller, Get, Post, Patch, Body, UseGuards, Request, Param } from '@nestjs/common';
import { StoresService } from './stores.service';
import { UploadStoreDocumentDto } from './dto/upload-store-document.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { UserRole, StoreStatus } from '@prisma/client';

@Controller('stores')
@UseGuards(JwtAuthGuard)
export class StoresController {
    constructor(private readonly storesService: StoresService) { }

    @Get('me')
    findMyStore(@Request() req) {
        return this.storesService.findMyStore(req.user.id);
    }

    @Patch('me')
    updateMyStore(@Request() req, @Body() dto: any) {
        return this.storesService.updateMyStore(req.user.id, dto);
    }

    @Post('onboarding/documents')
    uploadDocument(@Request() req, @Body() dto: UploadStoreDocumentDto) {
        return this.storesService.uploadDocument(req.user.id, dto);
    }

    @Get('me/dashboard')
    @UseGuards(RolesGuard)
    @Roles(UserRole.VENDOR)
    getDashboardStats(@Request() req) {
        return this.storesService.getDashboardStats(req.user.id);
    }

    @Get()
    @UseGuards(PermissionsGuard)
    @Permissions('users', 'view')
    findAll() {
        return this.storesService.findAll();
    }

    @Get(':id')
    @UseGuards(PermissionsGuard)
    @Permissions('users', 'view')
    findOne(@Param('id') id: string) {
        return this.storesService.findOne(id);
    }

    @Patch(':id/status')
    @UseGuards(PermissionsGuard)
    @Permissions('users', 'edit')
    updateStatus(
        @Request() req,
        @Param('id') id: string, 
        @Body() body: { status: StoreStatus, reason?: string, suspendedUntil?: Date }
    ) {
        return this.storesService.updateStatus(req.user.id, id, body.status, body.reason, body.suspendedUntil);
    }

    @Patch(':id/notes')
    @UseGuards(PermissionsGuard)
    @Permissions('users', 'edit')
    updateAdminNotes(
        @Request() req,
        @Param('id') id: string,
        @Body() body: { notes: string }
    ) {
        return this.storesService.updateAdminNotes(req.user.id, id, body.notes);
    }

    @Patch(':id/documents/:docType/status')
    @UseGuards(PermissionsGuard)
    @Permissions('users', 'edit')
    updateDocumentStatus(
        @Request() req,
        @Param('id') id: string,
        @Param('docType') docType: string,
        @Body() body: { status: string, reason?: string }
    ) {
        return this.storesService.updateDocumentStatus(req.user.id, id, docType, body.status, body.reason);
    }

    @Patch(':id/restrictions')
    @UseGuards(PermissionsGuard)
    @Permissions('users', 'edit')
    updateRestrictions(
        @Request() req,
        @Param('id') id: string,
        @Body() body: any
    ) {
        return this.storesService.adminUpdateRestrictions(id, req.user.id, body);
    }

    @Post(':id/clear-restrictions')
    @UseGuards(PermissionsGuard)
    @Permissions('users', 'edit')
    resetRestrictions(
        @Request() req,
        @Param('id') id: string,
        @Body() body: any
    ) {
        return this.storesService.adminResetOperationalRestrictions(id, req.user.id, body);
    }
}
