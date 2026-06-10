import {
    Injectable,
    Logger,
    UnauthorizedException,
    ConflictException,
    BadRequestException,
} from '@nestjs/common';
import { ActorType } from '@prisma/client';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UAParser } from 'ua-parser-js';
import * as geoip from 'geoip-lite';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { LoginDto } from './dto/login.dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { OtpService } from './otp.service';
import { OtpPurpose, OtpChannel } from './otp-purpose';
import { WidersContactSyncService } from '../widers/widers-contact-sync.service';
import { resolveJwtExpiresIn } from './jwt-expiry.util';

@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);

    constructor(
        private usersService: UsersService,
        private jwtService: JwtService,
        private prisma: PrismaService,
        private auditLogs: AuditLogsService,
        private platformSettings: PlatformSettingsService,
        private otpService: OtpService,
        private contactSync: WidersContactSyncService,
    ) { }

    private scheduleWidersContactSync(user: {
        id: string;
        phone: string | null;
        role: string;
        whatsappOptIn?: boolean;
        widersContactId?: string | null;
    }): void {
        void this.contactSync
            .syncOnLoginIfMissing({
                id: user.id,
                phone: user.phone,
                role: user.role as any,
                whatsappOptIn: user.whatsappOptIn ?? true,
                widersContactId: user.widersContactId ?? null,
            })
            .catch((err) =>
                this.logger.warn(
                    `Widers contact sync on login failed for ${user.id}: ${err instanceof Error ? err.message : err}`,
                ),
            );
    }

    private static readonly STAFF_ROLES = new Set([
        'ADMIN',
        'SUPER_ADMIN',
        'SUPPORT',
        'VERIFICATION_OFFICER',
    ]);

    private audienceForRole(role: string): 'customer' | 'vendor' {
        return role === 'VENDOR' ? 'vendor' : 'customer';
    }

    private isStaffRole(role: string): boolean {
        return AuthService.STAFF_ROLES.has(role);
    }

    async validateUser(email: string, pass: string): Promise<any> {
        const user = await this.usersService.findByEmail(email);
        if (user && (await bcrypt.compare(pass, user.passwordHash))) {
            const { passwordHash, ...result } = user;
            return result;
        }
        return null;
    }

    async login(user: any, ip?: string, userAgent?: string, fingerprint?: string) {
        const payload = { email: user.email, sub: user.id, role: user.role };
        const token = this.jwtService.sign(payload, {
            expiresIn: resolveJwtExpiresIn(user.role) as `${number}${'s' | 'm' | 'h' | 'd'}`,
        });

        // Enrich Session Data using 2026 Best Practices
        const parser = new UAParser(userAgent);
        const ua = parser.getResult();
        const osName = ua.os.name ? `${ua.os.name} ${ua.os.version || ''}` : 'Unknown OS';
        const browserName = ua.browser.name ? `${ua.browser.name} ${ua.browser.version || ''}` : 'Unknown Browser';
        const deviceName = ua.device.model ? `${ua.device.vendor || ''} ${ua.device.model}` : browserName;

        // Clean IP: Handle '::ffff:127.0.0.1' or proxy lists '1.1.1.1, 2.2.2.2'
        let cleanIp = ip || 'Unknown';
        if (cleanIp.includes(',')) cleanIp = cleanIp.split(',')[0].trim();
        if (cleanIp.startsWith('::ffff:')) cleanIp = cleanIp.substring(7);

        let location = 'Unknown Location';
        if (cleanIp && cleanIp !== '::1' && cleanIp !== '127.0.0.1' && !cleanIp.startsWith('192.168.')) {
            const geo = geoip.lookup(cleanIp);
            if (geo) {
                location = [geo.city, geo.region, geo.country].filter(Boolean).join(', ');
            }
        }

        // Session Deduplication Logic: Upsert if fingerprint exists
        if (fingerprint) {
            const sessions = await this.prisma.session.findMany({
                where: { userId: user.id, fingerprint: fingerprint }
            });

            if (sessions.length > 0) {
                // Update the most recent matching session
                await this.prisma.session.update({
                    where: { id: sessions[0].id },
                    data: {
                        token: token,
                        ip: cleanIp,
                        os: osName,
                        location: location,
                        device: deviceName,
                        lastActive: new Date(),
                    }
                });

                // Fetch permissions for Admin/Support/SuperAdmin/VerificationOfficer (2026 fix)
                let permissions = null;
                if (['ADMIN', 'SUPPORT', 'SUPER_ADMIN', 'VERIFICATION_OFFICER'].includes(user.role)) {
                    permissions = await this.prisma.adminPermission.findUnique({
                        where: { userId: user.id }
                    });
                }

                this.scheduleWidersContactSync(user);

                return {
                    access_token: token,
                    user: user,
                    permissions: permissions,
                };
            }
        }

        // Otherwise create new unique session
        await this.prisma.session.create({
            data: {
                userId: user.id,
                token: token,
                fingerprint: fingerprint,
                ip: cleanIp,
                device: deviceName,
                os: osName,
                location: location,
            }
        });

        // Log Admin Activity for 2026 Audit Standards
        if (['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'VERIFICATION_OFFICER'].includes(user.role)) {
            const loginMetadata = {
                os: osName,
                fingerprint: fingerprint || 'none',
                ip: cleanIp,
                browser: browserName,
                device: deviceName,
                location: location
            };

            const logData = {
                adminId: user.id,
                email: user.email,
                action: 'LOGIN',
                ipAddress: cleanIp,
                userAgent: userAgent,
                deviceType: ua.device.type || 'desktop',
                browser: browserName,
                location: location,
                metadata: loginMetadata
            };

            // 2026 Admin Session Management: Deduplicated Activity Logging
            await this.platformSettings.logAdminActivity(
                user.id,
                user.email,
                'LOGIN',
                loginMetadata,
                { 
                    ip: cleanIp, 
                    ua: userAgent, 
                    device: deviceName, 
                    browser: browserName, 
                    location: location 
                }
            );

            // 2026 Global Audit Stream Integration
            await this.auditLogs.logAction({
                action: 'LOGIN',
                entity: 'USER',
                actorType: ActorType.ADMIN,
                actorId: user.id,
                actorName: user.name,
                reason: `Administrative login from ${browserName} on ${osName}`,
                metadata: loginMetadata
            });
        }

        // Fetch permissions if Admin/Support/SuperAdmin/VerificationOfficer
        let permissions = null;
        if (['ADMIN', 'SUPPORT', 'SUPER_ADMIN', 'VERIFICATION_OFFICER'].includes(user.role)) {
            permissions = await this.prisma.adminPermission.findUnique({
                where: { userId: user.id }
            });
        }

        this.scheduleWidersContactSync(user);

        return {
            access_token: token,
            user: user,
            permissions: permissions
        };
    }

    async register(createUserDto: CreateUserDto) {
        if (createUserDto.phone) {
            const channel: OtpChannel = createUserDto.otpChannel ?? 'whatsapp';
            await this.otpService.assertRegisterVerified(
                createUserDto.phone,
                createUserDto.email,
                channel,
            );
        }
        const user = await this.usersService.create(createUserDto);
        void this.contactSync.syncRegisteredUser(user.id).catch((err) =>
            this.logger.warn(
                `Widers contact sync after register failed for ${user.id}: ${err instanceof Error ? err.message : err}`,
            ),
        );
        return user;
    }

    async initRegistration(
        email: string,
        phone: string,
        channel: OtpChannel,
        name?: string,
        audience: 'customer' | 'vendor' = 'customer',
    ) {
        const existingEmail = await this.usersService.findByEmail(email);
        if (existingEmail) {
            throw new ConflictException('Email already exists');
        }

        const existingPhone = await this.usersService.findByPhone(phone);
        if (existingPhone) {
            throw new ConflictException('Phone number already exists');
        }

        const result = await this.otpService.issueAndSend({
            channel,
            phone,
            email,
            purpose: OtpPurpose.REGISTER,
            audience,
            name,
        });

        if (channel === 'whatsapp') {
            void this.contactSync
                .syncLead({ phone, email, name, audience })
                .catch((err) =>
                    this.logger.warn(
                        `Widers lead sync failed for ${email}: ${err instanceof Error ? err.message : err}`,
                    ),
                );
        }

        return {
            success: true,
            message:
                channel === 'email'
                    ? 'Verification code sent to your email'
                    : 'Verification code sent via WhatsApp',
            channel: result.channel,
            expiresInMinutes: result.expiresInMinutes,
        };
    }

    async verifyRegistrationOtp(
        email: string,
        phone: string,
        code: string,
        channel: OtpChannel,
    ) {
        await this.otpService.verify({
            channel,
            phone: channel === 'whatsapp' ? phone : undefined,
            email,
            purpose: OtpPurpose.REGISTER,
            code,
        });

        return {
            success: true,
            message:
                channel === 'email'
                    ? 'Email verified. You may complete registration.'
                    : 'Phone verified. You may complete registration.',
            channel,
        };
    }

    async resendRegistrationOtp(
        email: string,
        phone: string,
        channel: OtpChannel,
        name?: string,
        audience: 'customer' | 'vendor' = 'customer',
    ) {
        const existingEmail = await this.usersService.findByEmail(email);
        if (existingEmail) {
            throw new ConflictException('Email already exists');
        }

        const existingPhone = await this.usersService.findByPhone(phone);
        if (existingPhone) {
            throw new ConflictException('Phone number already exists');
        }

        const result = await this.otpService.resend({
            channel,
            phone,
            email,
            purpose: OtpPurpose.REGISTER,
            audience,
            name,
        });

        return {
            success: true,
            message:
                channel === 'email'
                    ? 'Verification code resent to your email'
                    : 'Verification code resent via WhatsApp',
            channel: result.channel,
            expiresInMinutes: result.expiresInMinutes,
        };
    }

    async initiateMobileLogin(phone: string) {
        const user = await this.usersService.findByPhone(phone);

        if (!user) {
            return null;
        }

        if (!user.phone) {
            throw new BadRequestException('Account has no phone number on file');
        }

        const result = await this.otpService.issueAndSend({
            channel: 'whatsapp',
            phone: user.phone,
            purpose: OtpPurpose.LOGIN,
            audience: this.audienceForRole(user.role),
            name: user.name ?? undefined,
            email: user.email,
        });

        return {
            exists: true,
            otpSent: true,
            channel: 'whatsapp',
            expiresInMinutes: result.expiresInMinutes,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                role: user.role,
            },
        };
    }

    async initiateEmailLogin(email: string) {
        const user = await this.usersService.findByEmail(email);

        if (!user) {
            return null;
        }

        const result = await this.otpService.issueAndSend({
            channel: 'email',
            email: user.email,
            phone: user.phone ?? undefined,
            purpose: OtpPurpose.LOGIN,
            audience: this.audienceForRole(user.role),
            name: user.name ?? undefined,
        });

        return {
            exists: true,
            otpSent: true,
            channel: 'email',
            expiresInMinutes: result.expiresInMinutes,
            maskedEmail: user.email.replace(
                /^(.{1,2})(.*)(@.*)$/,
                (_, a, _mid, domain) => `${a}***${domain}`,
            ),
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                role: user.role,
            },
        };
    }

    async resendMobileLoginOtp(phone: string) {
        const user = await this.usersService.findByPhone(phone);
        if (!user?.phone) {
            throw new UnauthorizedException('Account not found');
        }

        const result = await this.otpService.resend({
            channel: 'whatsapp',
            phone: user.phone,
            purpose: OtpPurpose.LOGIN,
            audience: this.audienceForRole(user.role),
            name: user.name ?? undefined,
            email: user.email,
        });

        return {
            success: true,
            message: 'Verification code resent via WhatsApp',
            channel: 'whatsapp',
            expiresInMinutes: result.expiresInMinutes,
        };
    }

    async resendEmailLoginOtp(email: string) {
        const user = await this.usersService.findByEmail(email);
        if (!user) {
            throw new UnauthorizedException('Account not found');
        }

        const result = await this.otpService.resend({
            channel: 'email',
            email: user.email,
            phone: user.phone ?? undefined,
            purpose: OtpPurpose.LOGIN,
            audience: this.audienceForRole(user.role),
            name: user.name ?? undefined,
        });

        return {
            success: true,
            message: 'Verification code resent to your email',
            channel: 'email',
            expiresInMinutes: result.expiresInMinutes,
        };
    }

    async verifyEmailLogin(email: string, code: string, ip?: string, userAgent?: string, fingerprint?: string) {
        const user = await this.usersService.findByEmail(email);
        if (!user) {
            throw new UnauthorizedException('User not found');
        }

        await this.otpService.verify({
            channel: 'email',
            email: user.email,
            purpose: OtpPurpose.LOGIN,
            code,
        });

        return this.login(user, ip, userAgent, fingerprint);
    }

    async verifyMobileLogin(phone: string, code: string, ip?: string, userAgent?: string, fingerprint?: string) {
        const user = await this.usersService.findByPhone(phone);
        if (!user) {
            throw new UnauthorizedException('User not found');
        }

        await this.otpService.verify({
            channel: 'whatsapp',
            phone,
            purpose: OtpPurpose.LOGIN,
            code,
        });

        return this.login(user, ip, userAgent, fingerprint);
    }

    /**
     * Staff 2FA — send OTP after password step (Admin / Support / etc.).
     */
    async sendStaffOtp(email: string, channel: OtpChannel) {
        const user = await this.usersService.findByEmail(email);
        if (!user || !this.isStaffRole(user.role)) {
            throw new UnauthorizedException('Staff account not found');
        }

        if (channel === 'whatsapp' && !user.phone) {
            throw new BadRequestException(
                'Admin account has no phone on file. Choose email OTP or add a phone number.',
            );
        }

        const result = await this.otpService.issueAndSend({
            channel,
            phone: channel === 'whatsapp' ? user.phone! : undefined,
            email: user.email,
            purpose: OtpPurpose.LOGIN,
            audience: 'customer',
            name: user.name ?? undefined,
            role: user.role,
        });

        return {
            success: true,
            channel,
            expiresInMinutes: result.expiresInMinutes,
            maskedPhone:
                channel === 'whatsapp' && user.phone
                    ? user.phone.replace(/.(?=.{4})/g, '*')
                    : undefined,
            maskedEmail:
                channel === 'email'
                    ? user.email.replace(/^(.{1,2})(.*)(@.*)$/, (_, a, _m, d) => `${a}***${d}`)
                    : undefined,
        };
    }

    async verifyStaffOtp(email: string, code: string, channel: OtpChannel) {
        const user = await this.usersService.findByEmail(email);
        if (!user || !this.isStaffRole(user.role)) {
            throw new UnauthorizedException('Staff account not found');
        }

        if (channel === 'whatsapp' && !user.phone) {
            throw new BadRequestException('Admin account has no phone on file');
        }

        await this.otpService.verify({
            channel,
            phone: channel === 'whatsapp' ? user.phone! : undefined,
            email: user.email,
            purpose: OtpPurpose.LOGIN,
            code,
        });

        return { verified: true, success: true };
    }

    async resendStaffOtp(email: string, channel: OtpChannel) {
        return this.sendStaffOtp(email, channel);
    }

    async getUserProfile(userId: string) {
        const user = await this.usersService.findById(userId);
        if (!user) return null;
        // Return safe user object
        const { passwordHash, otpCode, otpExpiresAt, ...result } = user;
        return result;
    }

    async getActiveSessions(userId: string) {
        const sessions = await this.prisma.session.findMany({
            where: { userId },
            orderBy: { lastActive: 'desc' },
            select: {
                id: true,
                userId: true,
                device: true,
                os: true,
                ip: true,
                lastActive: true,
                createdAt: true,
            },
        });
        return sessions;
    }

    async terminateSession(userId: string, sessionId: string) {
        await this.prisma.session.deleteMany({
            where: { id: sessionId, userId: userId },
        });
        return { success: true };
    }

    async terminateAllOtherSessions(userId: string, currentToken: string) {
        await this.prisma.session.deleteMany({
            where: {
                userId,
                token: { not: currentToken }
            },
        });
        return { success: true };
    }

    async deleteAccount(userId: string) {
        // Optional Prisma delete if RLS/Triggers don't auto-cascade
        try {
            await this.prisma.user.delete({ where: { id: userId } });
        } catch (e) {
            // Prisma user delete skipped/failed, likely auto-cascaded or missing
        }

        // Delete from Supabase Auth
        const supabaseUrl = process.env.SUPABASE_URL || '';
        const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

        if (supabaseUrl && supabaseServiceKey) {
            // Import here to avoid overhead of module setup
            const { createClient } = require('@supabase/supabase-js');
            const supabase = createClient(supabaseUrl, supabaseServiceKey);

            await supabase.auth.admin.deleteUser(userId);
        }

        return { success: true };
    }
}
