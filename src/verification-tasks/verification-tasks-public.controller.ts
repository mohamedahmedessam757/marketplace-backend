import { Controller, Get, Param } from '@nestjs/common';
import { VerificationTasksService } from './verification-tasks.service';

/** Public endpoints — no JWT (link validation only). */
@Controller('verification-tasks/public')
export class VerificationTasksPublicController {
  constructor(private readonly tasksService: VerificationTasksService) {}

  @Get('link/:token')
  validateLink(@Param('token') token: string) {
    return this.tasksService.validatePublicLink(token);
  }
}
