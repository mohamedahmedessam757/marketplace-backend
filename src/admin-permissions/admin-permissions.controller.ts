import { 
  Controller, 
  Get, 
  Post, 
  Put, 
  Delete, 
  Body, 
  Param, 
  UseGuards, 
  Request, 
  ForbiddenException 
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { AdminPermissionsService } from './admin-permissions.service';
import { 
  CreateAdminDto, 
  UpdatePermissionsDto, 
  ChangeAdminPasswordDto 
} from './dto/admin-permissions.dto';

@Controller('admin-permissions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminPermissionsController {
  constructor(private readonly adminPermissionsService: AdminPermissionsService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN)
  async getAllAdmins() {
    return this.adminPermissionsService.findAllAdmins();
  }

  @Get('me')
  async getMyPermissions(@Request() req) {
    const userId = req.user.id || req.user.userId;
    return this.adminPermissionsService.getMyPermissions(userId);
  }

  @Get(':userId')
  @Roles(UserRole.SUPER_ADMIN)
  async getAdminById(@Param('userId') userId: string) {
    return this.adminPermissionsService.getAdminById(userId);
  }

  @Post('create-admin')
  @Roles(UserRole.SUPER_ADMIN)
  async createAdmin(@Body() dto: CreateAdminDto, @Request() req) {
    const actorId = req.user.id || req.user.userId;
    return this.adminPermissionsService.createAdmin(dto, actorId);
  }

  @Put(':userId')
  @Roles(UserRole.SUPER_ADMIN)
  async updatePermissions(
    @Param('userId') userId: string, 
    @Body() dto: UpdatePermissionsDto, 
    @Request() req
  ) {
    const actorId = req.user.id || req.user.userId;
    return this.adminPermissionsService.updatePermissions(userId, dto, actorId);
  }

  @Delete(':userId')
  @Roles(UserRole.SUPER_ADMIN)
  async deleteAdmin(@Param('userId') userId: string, @Request() req) {
    const actorId = req.user.id || req.user.userId;
    return this.adminPermissionsService.deleteAdmin(userId, actorId);
  }

  @Put(':userId/password')
  @Roles(UserRole.SUPER_ADMIN)
  async updatePassword(
    @Param('userId') userId: string, 
    @Body() dto: ChangeAdminPasswordDto, 
    @Request() req
  ) {
    const actorId = req.user.id || req.user.userId;
    return this.adminPermissionsService.updateAdminPassword(userId, dto, actorId);
  }
}
