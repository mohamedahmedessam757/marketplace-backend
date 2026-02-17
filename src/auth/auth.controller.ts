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

    @Post('mobile-login-init')
    async initiateMobileLogin(@Body() body: { phone: string }) {
        const result = await this.authService.initiateMobileLogin(body.phone);
        if (!result) {
            // We return a specific structure or 404 to let frontend know user doesn't exist
            // Frontend requirement: "If no, show message account not found please register"
            throw new UnauthorizedException('Account not found');
        }
        return result;
    }

    @Post('mobile-login-verify')
    async verifyMobileLogin(@Body() body: { phone: string; code: string }) {
        return this.authService.verifyMobileLogin(body.phone, body.code);
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
    async getProfile(@Request() req) {
        // Fetch full user data from DB to ensure we have latest avatar/details
        // req.user from JWT strategy might be limited or stale
        const user = await this.authService.getUserProfile(req.user.id || req.user.userId);
        return user;
    }
}
