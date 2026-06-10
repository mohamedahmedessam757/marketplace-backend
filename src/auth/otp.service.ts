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
import { WidersConfig } from '../widers/widers.config';
import { EmailChannelService } from '../email/email-channel.service';
import { EmailConfig } from '../email/email.config';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import {
    OtpPurpose,
    OtpChannel,
    OTP_DEV_BYPASS_CODE,
    OTP_EXPIRY_MINUTES,
    OTP_ISSUE_WINDOW_MINUTES,
    OTP_MAX_ISSUE_PER_WINDOW,
    OTP_MAX_VERIFY_ATTEMPTS,
} from './otp-purpose';

export interface IssueOtpParams {
    channel: OtpChannel;
    purpose: OtpPurpose;
    audience: 'customer' | 'vendor';
    phone?: string;
    name?: string;
    email?: string;
    role?: string;
    language?: 'ar' | 'en';
    metadata?: Record<string, unknown>;
}

export interface VerifyOtpParams {
    channel: OtpChannel;
    purpose: OtpPurpose;
    code: string;
    phone?: string;
    email?: string;
}

@Injectable()
export class OtpService {
    private readonly logger = new Logger(OtpService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly whatsapp: WhatsAppChannelService,
        private readonly widersConfig: WidersConfig,
        private readonly email: EmailChannelService,
        private readonly emailConfig: EmailConfig,
    ) {}

    private normalizePhone(phone: string): string {
        return phone.replace(/\s+/g, '').trim();
    }

    private generateCode(): string {
        return String(randomInt(100000, 1000000));
    }

    private isDevBypassActive(): boolean {
        if (process.env.OTP_DEV_BYPASS === 'false') return false;
        const anyChannelLive =
            this.widersConfig.enabled || this.emailConfig.enabled;
        return !anyChannelLive || process.env.OTP_DEV_BYPASS === 'true';
    }

    private logOtpToConsole(
        target: string,
        channel: OtpChannel,
        purpose: OtpPurpose,
        plainCode: string,
        context?: { role?: string; audience?: string; sent?: boolean; error?: string },
    ): void {
        const roleLabel = context?.role ?? context?.audience ?? 'user';
        const channelNote = context?.sent
            ? ''
            : context?.error
              ? ` (${channel} failed: ${context.error})`
              : ` (${channel} disabled — use console code or 123456)`;
        this.logger.warn(
            `[OTP] ${channel}=${target} purpose=${purpose} role=${roleLabel}: ${plainCode}${channelNote}`,
        );
    }

    private async enforceIssueRateLimit(
        channel: OtpChannel,
        purpose: OtpPurpose,
        phone?: string,
        email?: string,
    ): Promise<void> {
        const since = new Date(Date.now() - OTP_ISSUE_WINDOW_MINUTES * 60 * 1000);
        const where =
            channel === 'email' && email
                ? { email, channel, purpose, createdAt: { gte: since } }
                : {
                      phone: phone ? this.normalizePhone(phone) : undefined,
                      channel,
                      purpose,
                      createdAt: { gte: since },
                  };

        const count = await this.prisma.otpChallenge.count({ where });
        if (count >= OTP_MAX_ISSUE_PER_WINDOW) {
            throw new HttpException(
                'Too many OTP requests. Please wait before trying again.',
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }
    }

    private validateIssueParams(params: IssueOtpParams): void {
        if (params.channel === 'email' && !params.email?.trim()) {
            throw new BadRequestException('Email is required for email OTP');
        }
        if (params.channel === 'whatsapp' && !params.phone?.trim()) {
            throw new BadRequestException('Phone is required for WhatsApp OTP');
        }
    }

    async issueAndSend(
        params: IssueOtpParams,
    ): Promise<{ sent: boolean; channel: OtpChannel; expiresInMinutes: number }> {
        this.validateIssueParams(params);

        const phone =
            params.channel === 'whatsapp' && params.phone
                ? this.normalizePhone(params.phone)
                : params.phone
                  ? this.normalizePhone(params.phone)
                  : null;
        const email = params.email?.trim().toLowerCase() ?? null;

        await this.enforceIssueRateLimit(params.channel, params.purpose, phone ?? undefined, email ?? undefined);

        const plainCode = this.generateCode();
        const codeHash = await bcrypt.hash(plainCode, 10);
        const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

        const deleteWhere =
            params.channel === 'email' && email
                ? { email, channel: params.channel, purpose: params.purpose, verifiedAt: null }
                : {
                      phone: phone ?? undefined,
                      channel: params.channel,
                      purpose: params.purpose,
                      verifiedAt: null,
                  };

        await this.prisma.otpChallenge.deleteMany({ where: deleteWhere });

        await this.prisma.otpChallenge.create({
            data: {
                phone,
                email,
                channel: params.channel,
                purpose: params.purpose,
                role: params.role ?? null,
                codeHash,
                expiresAt,
                metadata: (params.metadata ?? {}) as object,
            },
        });

        const audience = params.audience === 'vendor' ? 'vendor' : 'customer';
        const displayName = params.name?.trim() || 'مستخدم';
        let sendResult: { sent: boolean; error?: string } = { sent: false };

        if (params.channel === 'whatsapp') {
            if (this.widersConfig.enabled && phone) {
                sendResult = await this.whatsapp.sendOtp(
                    audience,
                    phone,
                    displayName,
                    plainCode,
                    params.language ?? 'ar',
                );
                if (!sendResult.sent) {
                    this.logger.error(
                        `WhatsApp OTP send failed (${params.purpose}) → ${phone}: ${sendResult.error}`,
                    );
                }
            }
        } else if (params.channel === 'email' && email) {
            if (this.emailConfig.enabled) {
                sendResult = await this.email.sendOtp({
                    to: email,
                    name: displayName,
                    otpCode: plainCode,
                    language: params.language ?? 'ar',
                    purpose: params.purpose,
                });
                if (!sendResult.sent) {
                    this.logger.error(
                        `Email OTP send failed (${params.purpose}) → ${email}: ${sendResult.error}`,
                    );
                }
            }
        }

        if (!sendResult.sent) {
            const target = params.channel === 'email' ? (email ?? '') : (phone ?? '');
            this.logOtpToConsole(target, params.channel, params.purpose, plainCode, {
                role: params.role,
                audience,
                sent: false,
                error: sendResult.error,
            });
        }

        return {
            sent: sendResult.sent,
            channel: params.channel,
            expiresInMinutes: OTP_EXPIRY_MINUTES,
        };
    }

    private async findActiveChallenge(params: VerifyOtpParams) {
        const where =
            params.channel === 'email' && params.email
                ? {
                      email: params.email.trim().toLowerCase(),
                      channel: params.channel,
                      purpose: params.purpose,
                      verifiedAt: null,
                  }
                : {
                      phone: params.phone ? this.normalizePhone(params.phone) : undefined,
                      channel: params.channel,
                      purpose: params.purpose,
                      verifiedAt: null,
                  };

        return this.prisma.otpChallenge.findFirst({
            where,
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
        if (params.channel === 'email' && !params.email?.trim()) {
            throw new BadRequestException('Email is required for email OTP verification');
        }
        if (params.channel === 'whatsapp' && !params.phone?.trim()) {
            throw new BadRequestException('Phone is required for WhatsApp OTP verification');
        }

        const challenge = await this.findActiveChallenge(params);

        if (!challenge) {
            throw new BadRequestException('OTP expired or not requested');
        }

        if (
            params.email &&
            challenge.email &&
            challenge.email !== params.email.trim().toLowerCase()
        ) {
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
                `[OTP] Dev bypass code accepted (${params.channel}, ${params.purpose})`,
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
     * Registration gate — OTP must be verified within the last 30 minutes on the chosen channel.
     */
    async assertRegisterVerified(
        phone: string,
        email: string,
        channel: OtpChannel,
    ): Promise<void> {
        const since = new Date(Date.now() - 30 * 60 * 1000);
        const normalizedPhone = this.normalizePhone(phone);
        const normalizedEmail = email.trim().toLowerCase();

        const verified = await this.prisma.otpChallenge.findFirst({
            where: {
                channel,
                purpose: OtpPurpose.REGISTER,
                verifiedAt: { gte: since },
                ...(channel === 'email'
                    ? { email: normalizedEmail }
                    : { phone: normalizedPhone, email: normalizedEmail }),
            },
            orderBy: { verifiedAt: 'desc' },
        });

        if (!verified) {
            const hint =
                channel === 'email'
                    ? 'Email verification required. Please complete OTP first.'
                    : 'Phone verification required. Please complete WhatsApp OTP first.';
            throw new UnauthorizedException(hint);
        }
    }

    async assertRecoveryStep1Verified(email: string, role: string): Promise<void> {
        const since = new Date(Date.now() - 15 * 60 * 1000);
        const verified = await this.prisma.otpChallenge.findFirst({
            where: {
                email: email.trim().toLowerCase(),
                channel: 'email',
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

    async resend(params: IssueOtpParams): Promise<{ sent: boolean; channel: OtpChannel; expiresInMinutes: number }> {
        return this.issueAndSend(params);
    }
}
