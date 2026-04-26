import { Controller, Post, Body, Req, Ip, Get } from '@nestjs/common';
import { RecoveryService } from './recovery.service';
import { RequestEmailOtpDto, VerifyEmailOtpDto, RequestPhoneOtpDto, SubmitRecoveryDto } from './dto/recovery.dto';
import { Request } from 'express';

@Controller('auth/recovery')
export class RecoveryController {
    constructor(private readonly recoveryService: RecoveryService) { }

    @Post('request-email-otp')
    async requestEmailOtp(@Body() dto: RequestEmailOtpDto) {
        return this.recoveryService.requestEmailOtp(dto.email, dto.role);
    }

    @Post('verify-email-otp')
    async verifyEmailOtp(@Body() dto: VerifyEmailOtpDto, @Ip() ip: string) {
        return this.recoveryService.verifyEmailOtp(dto.email, dto.otp, dto.role, ip);
    }

    @Post('request-phone-otp')
    async requestPhoneOtp(@Body() dto: RequestPhoneOtpDto, @Ip() ip: string) {
        return this.recoveryService.requestPhoneOtp(dto.email, dto.newPhone, dto.role, ip);
    }

    @Post('submit')
    async submitRecovery(@Body() dto: SubmitRecoveryDto, @Req() req: Request, @Ip() ip: string) {
        const device = req.headers['user-agent'] || 'Unknown Device';
        return this.recoveryService.submitRecovery(dto.email, dto.newPhone, dto.phoneOtp, dto.role, ip, device);
    }

    // Admin Endpoints
    @Get('admin/requests')
    async getPendingRequests() {
        return this.recoveryService.getPendingRequests();
    }

    @Post('admin/resolve')
    async resolveRequest(
        @Body() body: { requestId: string, action: 'APPROVE' | 'REJECT' },
        @Req() req: any,
        @Ip() ip: string
    ) {
        const adminId = req.user?.id;
        const userAgent = req.headers['user-agent'] || 'Unknown';
        return this.recoveryService.resolveRequest(body.requestId, body.action, adminId, ip, userAgent);
    }
}
