import { Controller, Post, Get, Body, Param, UseGuards, Req, ForbiddenException } from '@nestjs/common';
import { VerificationTasksService } from './verification-tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { StartVerificationDto } from './dto/start-verification.dto';
import { CompleteVerificationDto } from './dto/complete-verification.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('verification-tasks')
@UseGuards(JwtAuthGuard)
export class VerificationTasksController {
  constructor(private readonly tasksService: VerificationTasksService) {}

  @Post()
  async assignTask(@Body() dto: CreateTaskDto, @Req() req: any) {
    if (!['ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
      throw new ForbiddenException('Only admins can assign tasks');
    }
    return this.tasksService.assignTask(dto, req.user.id);
  }

  @Get('my-tasks')
  async getMyTasks(@Req() req: any) {
    if (req.user.role !== 'VERIFICATION_OFFICER' && !['ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
      throw new ForbiddenException('Invalid role');
    }
    return this.tasksService.getMyTasks(req.user.id);
  }

  @Get('order/:orderId')
  async getTasksByOrder(@Param('orderId') orderId: string, @Req() req: any) {
    if (!['ADMIN', 'SUPER_ADMIN', 'SUPPORT'].includes(req.user.role)) {
      throw new ForbiddenException('Only admins can view order tasks');
    }
    return this.tasksService.getTasksByOrder(orderId);
  }

  @Post(':id/generate-link')
  async generateLink(@Param('id') taskId: string, @Req() req: any, @Body('durationHours') durationHours: number) {
    if (!['ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
      throw new ForbiddenException('Only admins can generate links');
    }
    return this.tasksService.generateLink(taskId, req.user.id, durationHours || 24);
  }

  @Get('officers')
  async listOfficers(@Req() req: any) {
    if (!['ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
      throw new ForbiddenException('Only admins can list officers');
    }
    return this.tasksService.listOfficers();
  }

  @Post('link/:token/activate')
  async activateLink(
    @Param('token') token: string,
    @Req() req: any,
    @Body() body: { lat?: number; lng?: number; deviceInfo?: Record<string, unknown> },
  ) {
    if (req.user.role !== 'VERIFICATION_OFFICER' && !['ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
      throw new ForbiddenException('Invalid role for link activation');
    }
    return this.tasksService.activateLink(token, req.user.id, body);
  }

  @Get('verify-link/:token')
  async verifyLink(@Param('token') token: string, @Req() req: any) {
    if (req.user.role !== 'VERIFICATION_OFFICER' && !['ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
      throw new ForbiddenException('Invalid role for link verification');
    }
    return this.tasksService.activateLink(token, req.user.id);
  }

  @Get(':id')
  async getTaskDetails(@Param('id') taskId: string, @Req() req: any) {
    if (req.user.role !== 'VERIFICATION_OFFICER' && !['ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
      throw new ForbiddenException('Invalid role');
    }
    return this.tasksService.getTaskDetails(taskId);
  }

  @Get(':id/activity-log')
  async getActivityLog(@Param('id') taskId: string, @Req() req: any) {
    if (!['ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
      throw new ForbiddenException('Only admins can view activity logs');
    }
    return this.tasksService.getActivityLog(taskId);
  }

  @Post(':id/start')
  async startVerification(
    @Param('id') taskId: string,
    @Body() dto: StartVerificationDto,
    @Req() req: any,
  ) {
    if (req.user.role !== 'VERIFICATION_OFFICER' && !['ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
      throw new ForbiddenException('Invalid role');
    }
    return this.tasksService.startVerification(taskId, req.user.id, dto);
  }

  @Post(':id/upload-photos')
  async uploadPhotos(
    @Param('id') taskId: string,
    @Body() dto: { photos: string[], lat?: number, lng?: number },
    @Req() req: any,
  ) {
    if (req.user.role !== 'VERIFICATION_OFFICER' && !['ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
      throw new ForbiddenException('Invalid role');
    }
    return this.tasksService.uploadPhotos(taskId, req.user.id, dto.photos, dto.lat, dto.lng);
  }

  @Post(':id/complete')
  async completeVerification(
    @Param('id') taskId: string,
    @Body() dto: CompleteVerificationDto,
    @Req() req: any,
  ) {
    if (req.user.role !== 'VERIFICATION_OFFICER' && !['ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
      throw new ForbiddenException('Invalid role');
    }
    return this.tasksService.completeVerification(taskId, req.user.id, dto);
  }
}
