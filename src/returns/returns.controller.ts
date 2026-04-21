import { Controller, Post, Patch, Body, UseInterceptors, UploadedFiles, UseGuards, Request, Get, BadRequestException, Param } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { ReturnsService } from './returns.service';

@Controller('returns')
export class ReturnsController {
    constructor(private readonly returnsService: ReturnsService) { }

    @Post('request')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FilesInterceptor('files', 10, { limits: { fileSize: 10 * 1024 * 1024 } }))
    async requestReturn(
        @Request() req,
        @UploadedFiles() files: Array<Express.Multer.File>,
        @Body() body: { orderId: string; orderPartId?: string; reason: string; description: string; usageCondition?: string }
    ) {
        if (!body.orderId || !body.reason) {
            throw new BadRequestException('Order ID and Reason are required');
        }

        return this.returnsService.requestReturn(
            req.user.id,
            body.orderId,
            body.orderPartId,
            body.reason,
            body.description,
            body.usageCondition,
            files
        );
    }

    @Post('dispute')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FilesInterceptor('files', 10, { limits: { fileSize: 10 * 1024 * 1024 } }))
    async escalateDispute(
        @Request() req,
        @UploadedFiles() files: Array<Express.Multer.File>,
        @Body() body: { orderId: string; orderPartId?: string; reason: string; description: string }
    ) {
        if (!body.orderId || !body.reason) {
            throw new BadRequestException('Order ID and Reason are required');
        }

        return this.returnsService.escalateDispute(
            req.user.id,
            body.orderId,
            body.orderPartId,
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

    @Get('debug-all-disputes')
    async getDebugAllDisputes() {
        const disputes = await this.returnsService['prisma'].dispute.findMany({
            include: {
                order: {
                    include: { 
                        parts: true,
                        store: true, 
                        acceptedOffer: {
                            include: { store: true }
                        },
                        orderChats: {
                            select: { id: true, vendorId: true }
                        }
                    }
                }
            },
            take: 5,
            orderBy: { createdAt: 'desc' }
        });
        return disputes;
    }

    @Patch(':id/escalate')
    @UseGuards(JwtAuthGuard)
    async escalateCase(@Request() req, @Param('id') id: string) {
        return this.returnsService.manualEscalation(req.user.id, id);
    }

    // --- Case Messaging (Phase 4) ---

    @Get(':id/messages')
    @UseGuards(JwtAuthGuard)
    async getCaseMessages(@Request() req, @Param('id') id: string) {
        return this.returnsService.getCaseMessages(req.user.id, req.user.role, id);
    }

    @Post(':id/messages')
    @UseGuards(JwtAuthGuard)
    async addCaseMessage(
        @Request() req,
        @Param('id') id: string,
        @Body() body: { caseType: 'return' | 'dispute'; text: string; attachments?: string[] }
    ) {
        if (!body.text) throw new BadRequestException('Message text is required');
        
        return this.returnsService.addCaseMessage(
            req.user.id,
            req.user.role,
            id,
            body.caseType,
            body.text,
            body.attachments || []
        );
    }

    // --- Merchant Endpoints ---

    @Get('merchant/cases')
    @UseGuards(JwtAuthGuard)
    async getMerchantCases(@Request() req) {
        return this.returnsService.getMerchantCases(req.user.id);
    }

    @Post(':id/respond-return')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FilesInterceptor('files', 10, { limits: { fileSize: 10 * 1024 * 1024 } }))
    async respondToReturn(
        @Request() req,
        @UploadedFiles() files: Array<Express.Multer.File>,
        @Body() body: { action: 'APPROVE' | 'REJECT'; responseText: string; evidenceUrls?: string[] }
    ) {
        if (body.action === 'REJECT' && (!body.responseText || body.responseText.trim() === '')) {
            throw new BadRequestException('Response text is required when rejecting a case');
        }

        return this.returnsService.respondToReturn(
            req.user.id,
            req.params.id,
            body.action,
            body.responseText || '',
            files,
            body.evidenceUrls
        );
    }

    @Post(':id/respond-dispute')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FilesInterceptor('files', 10, { limits: { fileSize: 10 * 1024 * 1024 } }))
    async respondToDispute(
        @Request() req,
        @UploadedFiles() files: Array<Express.Multer.File>,
        @Body() body: { responseText: string; evidenceUrls?: string[] }
    ) {
        if (!body.responseText) {
            throw new BadRequestException('Response Text is required');
        }

        return this.returnsService.respondToDispute(
            req.user.id,
            req.params.id,
            body.responseText,
            files,
            body.evidenceUrls
        );
    }

    // --- Admin Endpoints ---

    @Get('admin/cases')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.SUPPORT)
    async getAdminCases() {
        return this.returnsService.getAdminCases();
    }

    @Post(':id/verdict')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
    async issueVerdict(
        @Request() req,
        @Param('id') id: string,
        @Body() body: { 
            type: 'return' | 'dispute'; 
            verdict: 'REFUND' | 'RELEASE_FUNDS' | 'DENY'; 
            notes: string;
            extra?: any;
        }
    ) {
        if (!body.type || !body.verdict || !body.notes) {
            throw new BadRequestException('Type, Verdict, and Notes are required');
        }

        return this.returnsService.issueVerdict(
            req.user.id,
            id,
            body.type,
            body.verdict,
            body.notes,
            body.extra
        );
    }

    @Patch(':id/verdict')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
    async updateVerdict(
        @Request() req,
        @Param('id') id: string,
        @Body() body: { 
            type: 'return' | 'dispute'; 
            verdict: 'REFUND' | 'RELEASE_FUNDS' | 'DENY'; 
            notes: string;
            extra?: any;
        }
    ) {
        return this.returnsService.updateVerdict(
            req.user.id,
            id,
            body.type,
            body.verdict,
            body.notes,
            body.extra
        );
    }

    @Get('admin/merchant-risk/:storeId')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
    async getMerchantRiskStats(@Param('storeId') storeId: string) {
        return this.returnsService.getMerchantRiskStats(storeId);
    }

    @Get('admin/customer-risk/:customerId')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
    async getCustomerRiskStats(@Param('customerId') customerId: string) {
        return this.returnsService.getCustomerRiskStats(customerId);
    }
}
