import { Controller, Post, Body, UseGuards, Request, Get, UnauthorizedException, Delete, Param } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard'; // Will create this next
import { UserRole } from '@prisma/client';

@Controller('auth')
export class AuthController {
    constructor(private authService: AuthService) { }

    @Post('login')
    async login(@Body() loginDto: LoginDto, @Request() req) {
        const user = await this.authService.validateUser(loginDto.email, loginDto.password);
        if (!user) {
            throw new UnauthorizedException('Invalid credentials');
        }
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'];
        return this.authService.login(user, ip, userAgent, loginDto.fingerprint);
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
    async verifyMobileLogin(@Body() body: { phone: string; code: string; fingerprint?: string }, @Request() req) {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'];
        return this.authService.verifyMobileLogin(body.phone, body.code, ip, userAgent, body.fingerprint);
    }


    @Post('register-init')
    async initRegistration(@Body() body: { email: string, phone: string }) {
        return this.authService.initRegistration(body.email, body.phone);
    }

    @Post('register/customer')
    async registerCustomer(@Body() createUserDto: CreateUserDto) {
        // Force role to CUSTOMER
        createUserDto.role = UserRole.CUSTOMER;
        return this.authService.register(createUserDto);
    }

    @Post('register/vendor')
    async registerVendor(@Body() createUserDto: CreateUserDto, @Request() req) {
        // Force role to VENDOR (or pending logic later)
        createUserDto.role = UserRole.VENDOR;
        if (createUserDto.contractData) {
            createUserDto.contractData.ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            createUserDto.contractData.userAgent = req.headers['user-agent'];
        }
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

    // --- Session Management Endpoints ---

    @UseGuards(JwtAuthGuard)
    @Get('sessions')
    async getSessions(@Request() req) {
        return this.authService.getActiveSessions(req.user.id || req.user.userId);
    }

    @UseGuards(JwtAuthGuard)
    @Delete('sessions/all')
    async terminateAllSessions(@Request() req) {
        const token = req.headers.authorization?.replace('Bearer ', '');
        return this.authService.terminateAllOtherSessions(req.user.id || req.user.userId, token);
    }

    @UseGuards(JwtAuthGuard)
    @Delete('sessions/:id')
    async terminateSession(@Request() req, @Param('id') sessionId: string) {
        return this.authService.terminateSession(req.user.id || req.user.userId, sessionId);
    }

    @UseGuards(JwtAuthGuard)
    @Delete('me')
    async deleteAccount(@Request() req) {
        return this.authService.deleteAccount(req.user.id || req.user.userId);
    }
}
