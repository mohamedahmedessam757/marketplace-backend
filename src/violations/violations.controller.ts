import { Controller, Get, Post, Body, Patch, Param, UseGuards, Request, Query, ForbiddenException } from '@nestjs/common';
import { ViolationsService } from './violations.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { UserRole, ViolationTargetType } from '@prisma/client';
import { 
  IssueViolationDto, 
  SubmitAppealDto, 
  ReviewAppealDto, 
  CreateViolationTypeDto, 
  UpdateViolationTypeDto, 
  CreatePenaltyThresholdDto, 
  UpdatePenaltyThresholdDto, 
  ReviewPenaltyDto,
  ResolveRiskAlertDto 
} from './dto';

@Controller('violations')
@UseGuards(JwtAuthGuard)
export class ViolationsController {
  constructor(private readonly violationsService: ViolationsService) {}

  // --- USER ENDPOINTS (Customer/Merchant) ---

  @Get('my')
  getMyViolations(@Request() req) {
    return this.violationsService.getUserViolations(req.user.id);
  }

  @Get('score')
  async getMyScore(@Request() req) {
    const score = await this.violationsService.getViolationScore(req.user.id);
    return { score };
  }

  @Get('history')
  getMyScoreHistory(@Request() req) {
    return this.violationsService.getScoreHistory(req.user.id);
  }

  @Post(':id/appeal')
  submitAppeal(@Request() req, @Param('id') id: string, @Body() dto: SubmitAppealDto) {
    return this.violationsService.submitAppeal(id, req.user.id, dto);
  }

  @Get('types')
  getPublicViolationTypes(@Query('targetType') targetType?: ViolationTargetType) {
    return this.violationsService.getViolationTypes(targetType);
  }

  @Get('thresholds')
  getPublicPenaltyThresholds(@Query('targetType') targetType?: ViolationTargetType) {
    return this.violationsService.getPenaltyThresholds(targetType);
  }

  // --- ADMINISTRATIVE ENDPOINTS (ADMIN Only) ---

  @UseGuards(PermissionsGuard)
  @Permissions('violations', 'view')
  @Get('admin')
  getAllViolations(@Query() filters: any) {
    return this.violationsService.getAllViolations(filters);
  }

  @UseGuards(PermissionsGuard)
  @Permissions('violations', 'edit')
  @Post('admin/issue')
  issueViolation(@Request() req, @Body() dto: IssueViolationDto) {
    return this.violationsService.issueViolation(dto, req.user.id);
  }

  @Get('admin/types')
  @UseGuards(PermissionsGuard)
  @Permissions('violations', 'view')
  getViolationTypes(@Query('targetType') targetType?: ViolationTargetType) {
    return this.violationsService.getViolationTypes(targetType);
  }

  @Post('admin/types')
  @UseGuards(PermissionsGuard)
  @Permissions('violations', 'edit')
  createViolationType(@Request() req, @Body() dto: CreateViolationTypeDto) {
    return this.violationsService.createViolationType(dto, req.user.id);
  }

  @Patch('admin/types/:id')
  @UseGuards(PermissionsGuard)
  @Permissions('violations', 'edit')
  updateViolationType(@Request() req, @Param('id') id: string, @Body() dto: UpdateViolationTypeDto) {
    return this.violationsService.updateViolationType(id, dto, req.user.id);
  }

  @Get('admin/thresholds')
  @UseGuards(PermissionsGuard)
  @Permissions('violations', 'view')
  getPenaltyThresholds(@Query('targetType') targetType?: ViolationTargetType) {
    return this.violationsService.getPenaltyThresholds(targetType);
  }

  @Post('admin/thresholds')
  @UseGuards(PermissionsGuard)
  @Permissions('violations', 'edit')
  createPenaltyThreshold(@Body() dto: CreatePenaltyThresholdDto) {
    return this.violationsService.createPenaltyThreshold(dto);
  }

  @Patch('admin/thresholds/:id')
  @UseGuards(PermissionsGuard)
  @Permissions('violations', 'edit')
  updatePenaltyThreshold(@Param('id') id: string, @Body() dto: UpdatePenaltyThresholdDto) {
    return this.violationsService.updatePenaltyThreshold(id, dto);
  }

  @Get('admin/appeals/pending')
  @UseGuards(PermissionsGuard)
  @Permissions('violations', 'view')
  getPendingAppeals() {
    return this.violationsService.getPendingAppeals();
  }

  @Patch('admin/appeals/:id/review')
  @UseGuards(PermissionsGuard)
  @Permissions('violations', 'edit')
  reviewAppeal(@Request() req, @Param('id') id: string, @Body() dto: ReviewAppealDto) {
    return this.violationsService.reviewAppeal(id, req.user.id, dto);
  }

  @Get('admin/penalties/pending')
  @UseGuards(PermissionsGuard)
  @Permissions('violations', 'view')
  getPendingPenalties() {
    return this.violationsService.getPendingPenalties();
  }

  @Patch('admin/penalties/:id/review')
  @UseGuards(PermissionsGuard)
  @Permissions('violations', 'edit')
  reviewPenalty(@Request() req, @Param('id') id: string, @Body() dto: ReviewPenaltyDto) {
    return this.violationsService.reviewPenaltyAction(id, req.user.id, dto);
  }

  // --- CUSTOMER RISK GOVERNANCE (2026) ---

  @Get('admin/risk-alerts')
  @UseGuards(PermissionsGuard)
  @Permissions('violations', 'view')
  getRiskAlerts(@Query('status') status?: string) {
    return this.violationsService.getRiskAlerts(status);
  }

  @Patch('admin/risk-alerts/:id/resolve')
  @UseGuards(PermissionsGuard)
  @Permissions('violations', 'edit')
  resolveRiskAlert(@Request() req, @Param('id') id: string, @Body() dto: ResolveRiskAlertDto) {
    return this.violationsService.resolveRiskAlert(id, dto, req.user.id);
  }
}
