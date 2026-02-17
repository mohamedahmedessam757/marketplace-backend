import { Controller, Get, Param, UseGuards, Request, Post, Body } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) { }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  getProfile(@Request() req) {
    return req.user;
  }

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
