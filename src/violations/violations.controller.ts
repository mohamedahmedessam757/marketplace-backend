import { Controller, Get, Post, Body, Patch, Param, UseGuards, Request, Query, ForbiddenException } from '@nestjs/common';
import { ViolationsService } from './violations.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
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

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('admin')
  getAllViolations(@Query() filters: any) {
    return this.violationsService.getAllViolations(filters);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post('admin/issue')
  issueViolation(@Request() req, @Body() dto: IssueViolationDto) {
    return this.violationsService.issueViolation(dto, req.user.id);
  }

  @Get('admin/types')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  getViolationTypes(@Query('targetType') targetType?: ViolationTargetType) {
    return this.violationsService.getViolationTypes(targetType);
  }

  @Post('admin/types')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  createViolationType(@Request() req, @Body() dto: CreateViolationTypeDto) {
    return this.violationsService.createViolationType(dto, req.user.id);
  }

  @Patch('admin/types/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  updateViolationType(@Request() req, @Param('id') id: string, @Body() dto: UpdateViolationTypeDto) {
    return this.violationsService.updateViolationType(id, dto, req.user.id);
  }

  @Get('admin/thresholds')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  getPenaltyThresholds(@Query('targetType') targetType?: ViolationTargetType) {
    return this.violationsService.getPenaltyThresholds(targetType);
  }

  @Post('admin/thresholds')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  createPenaltyThreshold(@Body() dto: CreatePenaltyThresholdDto) {
    return this.violationsService.createPenaltyThreshold(dto);
  }

  @Patch('admin/thresholds/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  updatePenaltyThreshold(@Param('id') id: string, @Body() dto: UpdatePenaltyThresholdDto) {
    return this.violationsService.updatePenaltyThreshold(id, dto);
  }

  @Get('admin/appeals/pending')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  getPendingAppeals() {
    return this.violationsService.getPendingAppeals();
  }

  @Patch('admin/appeals/:id/review')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  reviewAppeal(@Request() req, @Param('id') id: string, @Body() dto: ReviewAppealDto) {
    return this.violationsService.reviewAppeal(id, req.user.id, dto);
  }

  @Get('admin/penalties/pending')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  getPendingPenalties() {
    return this.violationsService.getPendingPenalties();
  }

  @Patch('admin/penalties/:id/review')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  reviewPenalty(@Request() req, @Param('id') id: string, @Body() dto: ReviewPenaltyDto) {
    return this.violationsService.reviewPenaltyAction(id, req.user.id, dto);
  }

  // --- CUSTOMER RISK GOVERNANCE (2026) ---

  @Get('admin/risk-alerts')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  getRiskAlerts(@Query('status') status?: string) {
    return this.violationsService.getRiskAlerts(status);
  }

  @Patch('admin/risk-alerts/:id/resolve')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  resolveRiskAlert(@Request() req, @Param('id') id: string, @Body() dto: ResolveRiskAlertDto) {
    return this.violationsService.resolveRiskAlert(id, dto, req.user.id);
  }
}
