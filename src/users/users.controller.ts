import { Controller, Get, Param, UseGuards, Request, Post, Body, Patch, ForbiddenException, Query } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) { }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  getProfile(@Request() req) {
    return req.user;
  }

  // --- Administrative Endpoints (ADMIN/SUPER_ADMIN Only) ---

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('admin/customers')
  async getAllCustomers() {
    return this.usersService.adminFindAllCustomers();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('admin/search')
  async searchEntities(@Query('q') query: string) {
    return this.usersService.adminSearchEntities(query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('admin/customers/:id')
  async getCustomerById(@Param('id') id: string) {
    return this.usersService.adminFindCustomerById(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Patch('admin/customers/:id/status')
  async updateCustomerStatus(
    @Param('id') id: string, 
    @Body() body: { status: 'ACTIVE' | 'SUSPENDED'; reason?: string }
  ) {
    return this.usersService.adminUpdateStatus(id, body.status, body.reason);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Patch('admin/customers/:id/update')
  async updateCustomerData(@Param('id') id: string, @Body() body: any) {
    return this.usersService.adminUpdateCustomer(id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Patch('admin/customers/:id/notes')
  async updateCustomerNotes(@Param('id') id: string, @Body() body: { notes: string }) {
    return this.usersService.adminUpdateNotes(id, body.notes);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Patch('admin/customers/:id/restrictions')
  async updateCustomerRestrictions(
    @Request() req,
    @Param('id') id: string, 
    @Body() body: any
  ) {
    return this.usersService.adminUpdateRestrictions(id, req.user.id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post('admin/customers/:id/clear-restrictions')
  async clearCustomerRestrictions(
    @Request() req,
    @Param('id') id: string,
    @Body() body: any
  ) {
    return this.usersService.adminClearRestrictions(id, req.user.id, body);
  }

  // --- Profile Endpoints ---

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.usersService.findById(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('profile/update')
  async updateProfile(@Request() req, @Body() body: { name?: string; phone?: string; avatar?: string }) {
    console.log('Update Profile Request:', { userId: req.user?.id, body });
    // Proxy update to bypass RLS
    try {
      return await this.usersService.update(req.user.id || req.user.userId, body);
    } catch (error) {
      console.error('Update Profile Error:', error);
      throw error;
    }
  }
}
