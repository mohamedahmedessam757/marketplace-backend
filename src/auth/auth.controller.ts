import { Controller, Post, Body, UseGuards, Request, Get, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard'; // Will create this next
import { UserRole } from '@prisma/client';

@Controller('auth')
export class AuthController {
    constructor(private authService: AuthService) { }

    @Post('login')
    async login(@Body() loginDto: LoginDto) {
        const user = await this.authService.validateUser(loginDto.email, loginDto.password);
        if (!user) {
            throw new UnauthorizedException('Invalid credentials');
        }
        return this.authService.login(user);
    }

    @Post('register/customer')
    async registerCustomer(@Body() createUserDto: CreateUserDto) {
        // Force role to CUSTOMER
        createUserDto.role = UserRole.CUSTOMER;
        return this.authService.register(createUserDto);
    }

    @Post('register/vendor')
    async registerVendor(@Body() createUserDto: CreateUserDto) {
        // Force role to VENDOR (or pending logic later)
        createUserDto.role = UserRole.VENDOR;
        return this.authService.register(createUserDto);
    }

    // Example protected route to verify JWT
    @UseGuards(JwtAuthGuard)
    @Get('profile')
    getProfile(@Request() req) {
        return req.user;
    }
}
