import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UAParser } from 'ua-parser-js';
import * as geoip from 'geoip-lite';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { LoginDto } from './dto/login.dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

@Injectable()
export class AuthService {
    constructor(
        private usersService: UsersService,
        private jwtService: JwtService,
        private prisma: PrismaService,
        private auditLogs: AuditLogsService,
    ) { }

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
        const token = this.jwtService.sign(payload);

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

                return {
                    access_token: token,
                    user: user,
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
        if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN' || user.role === 'SUPPORT') {
            const loginMetadata = {
                os: osName,
                fingerprint: fingerprint || 'none',
                ip: cleanIp,
                browser: browserName,
                device: deviceName,
                location: location
            };

            await this.prisma.adminActivityLog.create({
                data: {
                    adminId: user.id,
                    email: user.email,
                    action: 'LOGIN',
                    ipAddress: cleanIp,
                    userAgent: userAgent,
                    deviceType: ua.device.type || 'desktop',
                    browser: browserName,
                    location: location,
                    metadata: loginMetadata
                }
            });

            // 2026 Global Audit Stream Integration
            await this.auditLogs.logAction({
                action: 'LOGIN',
                entity: 'USER',
                actorType: user.role as any,
                actorId: user.id,
                actorName: user.name,
                reason: `Administrative login from ${browserName} on ${osName}`,
                metadata: loginMetadata
            });
        }

        return {
            access_token: token,
            user: user,
        };
    }

    async register(createUserDto: CreateUserDto) {
        return this.usersService.create(createUserDto);
    }

    async initRegistration(email: string, phone: string) {
        // 1. Check for Duplicate Email
        const existingEmail = await this.usersService.findByEmail(email);
        if (existingEmail) {
            throw new ConflictException('Email already exists');
        }

        // 2. Check for Duplicate Phone
        const existingPhone = await this.usersService.findByPhone(phone);
        if (existingPhone) {
            throw new ConflictException('Phone number already exists');
        }

        // 3. Return success (In production, dispatch actual OTPs here)
        return {
            success: true,
            message: 'Verification codes sent',
            mockCode: '123456'
        };
    }

    async initiateMobileLogin(phone: string) {
        console.log(`[AuthService] Initiating login for phone: ${phone}`);
        const user = await this.usersService.findByPhone(phone);
        
        if (!user) {
            console.warn(`[AuthService] User not found for phone: ${phone}`);
            return null; // Controller will handle 404/Unauthorized
        }

        console.log(`[AuthService] User found: ${user.id}, Role: ${user.role}`);

        // Return public user info needed for OTP selection
        return {
            exists: true,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                role: user.role
            }
        };
    }

    async initiateEmailLogin(email: string) {
        console.log(`[AuthService] Initiating login for email: ${email}`);
        const user = await this.usersService.findByEmail(email);
        
        if (!user) {
            console.warn(`[AuthService] User not found for email: ${email}`);
            return null;
        }

        console.log(`[AuthService] Email user found: ${user.id}, Role: ${user.role}`);

        return {
            exists: true,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone || '',
                role: user.role
            }
        };
    }

    async verifyEmailLogin(email: string, code: string, ip?: string, userAgent?: string, fingerprint?: string) {
        // 1. Verify OTP (Mock for now)
        if (code !== '123456') { 
            throw new UnauthorizedException('Invalid verification code');
        }

        // 2. Find User
        const user = await this.usersService.findByEmail(email);
        if (!user) {
            throw new UnauthorizedException('User not found');
        }

        // 3. Generate Token
        return this.login(user, ip, userAgent, fingerprint); 
    }

    async verifyMobileLogin(phone: string, code: string, ip?: string, userAgent?: string, fingerprint?: string) {
        // 1. Verify OTP (Mock for now)
        if (code !== '123456') { 
            throw new UnauthorizedException('Invalid verification code');
        }

        // 2. Find User
        const user = await this.usersService.findByPhone(phone);
        if (!user) {
            throw new UnauthorizedException('User not found');
        }

        // 3. Generate Token with full enrichment
        return this.login(user, ip, userAgent, fingerprint); 
    }

    async getUserProfile(userId: string) {
        const user = await this.usersService.findById(userId);
        if (!user) return null;
        // Return safe user object
        const { passwordHash, otpCode, otpExpiresAt, ...result } = user;
        return result;
    }

    async getActiveSessions(userId: string) {
        return this.prisma.session.findMany({
            where: { userId },
            orderBy: { lastActive: 'desc' },
        });
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
            console.warn('Prisma user delete skipped/failed, likely auto-cascaded or missing:', e);
        }

        // Delete from Supabase Auth
        const supabaseUrl = process.env.SUPABASE_URL || '';
        const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

        if (supabaseUrl && supabaseServiceKey) {
            // Import here to avoid overhead of module setup
            const { createClient } = require('@supabase/supabase-js');
            const supabase = createClient(supabaseUrl, supabaseServiceKey);

            const { error } = await supabase.auth.admin.deleteUser(userId);
            if (error) {
                console.error('Supabase Auth Delete Error:', error);
                // We won't throw here if the user was already deleted, just log it.
            }
        }

        return { success: true };
    }
}
