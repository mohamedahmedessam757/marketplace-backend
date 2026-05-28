import { Controller, Post, Body, Req, Ip, Get, UseGuards } from '@nestjs/common';
import { RecoveryService } from './recovery.service';
import { RequestEmailOtpDto, VerifyEmailOtpDto, RequestPhoneOtpDto, SubmitRecoveryDto } from './dto/recovery.dto';
import { Request } from 'express';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { Permissions } from './decorators/permissions.decorator';
import { Throttle } from '@nestjs/throttler';

@Controller('auth/recovery')
export class RecoveryController {
    constructor(private readonly recoveryService: RecoveryService) { }

    @Post('request-email-otp')
    @Throttle({ default: { limit: 5, ttl: 60_000 } })
    async requestEmailOtp(@Body() dto: RequestEmailOtpDto) {
        return this.recoveryService.requestEmailOtp(dto.email, dto.role);
    }

    @Post('verify-email-otp')
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    async verifyEmailOtp(@Body() dto: VerifyEmailOtpDto, @Ip() ip: string) {
        return this.recoveryService.verifyEmailOtp(dto.email, dto.otp, dto.role, ip);
    }

    @Post('request-phone-otp')
    @Throttle({ default: { limit: 5, ttl: 60_000 } })
    async requestPhoneOtp(@Body() dto: RequestPhoneOtpDto, @Ip() ip: string) {
        return this.recoveryService.requestPhoneOtp(dto.email, dto.newPhone, dto.role, ip);
    }

    @Post('submit')
    @Throttle({ default: { limit: 5, ttl: 60_000 } })
    async submitRecovery(@Body() dto: SubmitRecoveryDto, @Req() req: Request, @Ip() ip: string) {
        const device = req.headers['user-agent'] || 'Unknown Device';
        return this.recoveryService.submitRecovery(dto.email, dto.newPhone, dto.phoneOtp, dto.role, ip, device);
    }

    @Get('admin/requests')
    @UseGuards(JwtAuthGuard, PermissionsGuard)
    @Permissions('users', 'view')
    async getPendingRequests() {
        return this.recoveryService.getPendingRequests();
    }

    @Post('admin/resolve')
    @UseGuards(JwtAuthGuard, PermissionsGuard)
    @Permissions('users', 'edit')
    async resolveRequest(
        @Body() body: { requestId: string, action: 'APPROVE' | 'REJECT' },
        @Req() req: Request & { user: { id: string } },
        @Ip() ip: string
    ) {
        const adminId = req.user.id;
        const userAgent = req.headers['user-agent'] || 'Unknown';
        return this.recoveryService.resolveRequest(body.requestId, body.action, adminId, ip, userAgent);
    }
}
