import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UAParser } from 'ua-parser-js';
import * as geoip from 'geoip-lite';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
    constructor(
        private usersService: UsersService,
        private jwtService: JwtService,
        private prisma: PrismaService,
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

        let location = 'Unknown Location';
        if (ip && ip !== '::1' && ip !== '127.0.0.1' && !ip.startsWith('192.168.')) {
            const geo = geoip.lookup(ip);
            if (geo) {
                location = `${geo.city || ''}, ${geo.country || geo.timezone || ''}`.trim().replace(/^,/, '');
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
                        ip: ip || 'Unknown',
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
                ip: ip || 'Unknown',
                device: deviceName,
                os: osName,
                location: location,
            }
        });

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
