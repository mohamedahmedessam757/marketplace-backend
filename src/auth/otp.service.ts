import {
    BadRequestException,
    HttpException,
    HttpStatus,
    Injectable,
    Logger,
    UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppChannelService } from '../widers/whatsapp-channel.service';
import { WidersService } from '../widers/widers.service';
import { WidersConfig } from '../widers/widers.config';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import {
    OtpPurpose,
    OTP_DEV_BYPASS_CODE,
    OTP_EXPIRY_MINUTES,
    OTP_ISSUE_WINDOW_MINUTES,
    OTP_MAX_ISSUE_PER_WINDOW,
    OTP_MAX_VERIFY_ATTEMPTS,
} from './otp-purpose';

export interface IssueOtpParams {
    phone: string;
    purpose: OtpPurpose;
    audience: 'customer' | 'vendor';
    name?: string;
    email?: string;
    role?: string;
    metadata?: Record<string, unknown>;
}

export interface VerifyOtpParams {
    phone: string;
    purpose: OtpPurpose;
    code: string;
    email?: string;
}

@Injectable()
export class OtpService {
    private readonly logger = new Logger(OtpService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly whatsapp: WhatsAppChannelService,
        private readonly widers: WidersService,
        private readonly widersConfig: WidersConfig,
    ) {}

    private normalizePhone(phone: string): string {
        return this.widers.normalizePhone(phone);
    }

    private generateCode(): string {
        return String(randomInt(100000, 1000000));
    }

    private isDevBypassActive(): boolean {
        if (process.env.OTP_DEV_BYPASS === 'false') return false;
        return !this.widersConfig.enabled || process.env.OTP_DEV_BYPASS === 'true';
    }

    private logOtpToConsole(
        phone: string,
        purpose: OtpPurpose,
        plainCode: string,
        context?: { role?: string; audience?: string; whatsappSent?: boolean; error?: string },
    ): void {
        const roleLabel = context?.role ?? context?.audience ?? 'user';
        const channelNote = context?.whatsappSent
            ? ''
            : context?.error
              ? ` (whatsapp failed: ${context.error})`
              : ' (whatsapp disabled — use console code or 123456 until templates APPROVED)';
        this.logger.warn(
            `[OTP] phone=${phone} purpose=${purpose} role=${roleLabel}: ${plainCode}${channelNote}`,
        );
    }

    private async enforceIssueRateLimit(phone: string, purpose: OtpPurpose): Promise<void> {
        const since = new Date(Date.now() - OTP_ISSUE_WINDOW_MINUTES * 60 * 1000);
        const count = await this.prisma.otpChallenge.count({
            where: { phone, purpose, createdAt: { gte: since } },
        });
        if (count >= OTP_MAX_ISSUE_PER_WINDOW) {
            throw new HttpException(
                'Too many OTP requests. Please wait before trying again.',
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }
    }

    async issueAndSend(params: IssueOtpParams): Promise<{ sent: boolean; expiresInMinutes: number }> {
        const phone = this.normalizePhone(params.phone);
        await this.enforceIssueRateLimit(phone, params.purpose);

        const plainCode = this.generateCode();
        const codeHash = await bcrypt.hash(plainCode, 10);
        const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

        await this.prisma.otpChallenge.deleteMany({
            where: {
                phone,
                purpose: params.purpose,
                verifiedAt: null,
            },
        });

        await this.prisma.otpChallenge.create({
            data: {
                phone,
                email: params.email ?? null,
                purpose: params.purpose,
                role: params.role ?? null,
                codeHash,
                expiresAt,
                metadata: (params.metadata ?? {}) as object,
            },
        });

        const audience = params.audience === 'vendor' ? 'vendor' : 'customer';
        let sendResult: { sent: boolean; error?: string } = { sent: false };

        if (this.widersConfig.enabled) {
            sendResult = await this.whatsapp.sendOtp(
                audience,
                phone,
                params.name?.trim() || 'مستخدم',
                plainCode,
                'ar',
            );
            if (!sendResult.sent) {
                this.logger.error(
                    `WhatsApp OTP send failed (${params.purpose}) → ${phone}: ${sendResult.error}`,
                );
            }
        }

        if (!sendResult.sent) {
            this.logOtpToConsole(phone, params.purpose, plainCode, {
                role: params.role,
                audience,
                whatsappSent: false,
                error: sendResult.error,
            });
        }

        return { sent: sendResult.sent, expiresInMinutes: OTP_EXPIRY_MINUTES };
    }

    private async findActiveChallenge(params: VerifyOtpParams) {
        const phone = this.normalizePhone(params.phone);
        return this.prisma.otpChallenge.findFirst({
            where: {
                phone,
                purpose: params.purpose,
                verifiedAt: null,
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    private async markChallengeVerified(challengeId: string): Promise<void> {
        await this.prisma.otpChallenge.update({
            where: { id: challengeId },
            data: { verifiedAt: new Date() },
        });
    }

    async verify(params: VerifyOtpParams): Promise<{ verified: boolean }> {
        const phone = this.normalizePhone(params.phone);
        const challenge = await this.findActiveChallenge(params);

        if (!challenge) {
            throw new BadRequestException('OTP expired or not requested');
        }

        if (params.email && challenge.email && challenge.email !== params.email) {
            throw new UnauthorizedException('Invalid verification context');
        }

        if (challenge.expiresAt < new Date()) {
            await this.prisma.otpChallenge.delete({ where: { id: challenge.id } });
            throw new BadRequestException('OTP expired. Please request a new code.');
        }

        if (challenge.attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
            throw new UnauthorizedException('Too many failed attempts. Please request a new code.');
        }

        const devBypass =
            this.isDevBypassActive() && params.code === OTP_DEV_BYPASS_CODE;

        if (devBypass) {
            this.logger.warn(
                `[OTP] Dev bypass code accepted for ${phone} (${params.purpose}) — disable when WIDERS templates are live`,
            );
            await this.markChallengeVerified(challenge.id);
            return { verified: true };
        }

        const valid = await bcrypt.compare(params.code, challenge.codeHash);
        if (!valid) {
            await this.prisma.otpChallenge.update({
                where: { id: challenge.id },
                data: { attempts: { increment: 1 } },
            });
            const remaining = OTP_MAX_VERIFY_ATTEMPTS - challenge.attempts - 1;
            throw new BadRequestException(
                `Invalid OTP. Attempts remaining: ${Math.max(remaining, 0)}`,
            );
        }

        await this.markChallengeVerified(challenge.id);
        return { verified: true };
    }

    /**
     * Registration gate — phone OTP must be verified within the last 30 minutes.
     */
    async assertRegisterVerified(phone: string, email: string): Promise<void> {
        const normalized = this.normalizePhone(phone);
        const since = new Date(Date.now() - 30 * 60 * 1000);

        const verified = await this.prisma.otpChallenge.findFirst({
            where: {
                phone: normalized,
                email,
                purpose: OtpPurpose.REGISTER,
                verifiedAt: { gte: since },
            },
            orderBy: { verifiedAt: 'desc' },
        });

        if (!verified) {
            throw new UnauthorizedException(
                'Phone verification required. Please complete WhatsApp OTP first.',
            );
        }
    }

    async assertRecoveryStep1Verified(email: string, role: string): Promise<void> {
        const since = new Date(Date.now() - 15 * 60 * 1000);
        const verified = await this.prisma.otpChallenge.findFirst({
            where: {
                email,
                role,
                purpose: OtpPurpose.RECOVERY_STEP1,
                verifiedAt: { gte: since },
            },
            orderBy: { verifiedAt: 'desc' },
        });

        if (!verified) {
            throw new UnauthorizedException('Session expired. Please restart the recovery process.');
        }
    }

    async resend(params: IssueOtpParams): Promise<{ sent: boolean; expiresInMinutes: number }> {
        return this.issueAndSend(params);
    }
}
