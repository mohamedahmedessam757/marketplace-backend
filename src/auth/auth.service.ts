import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
    constructor(
        private usersService: UsersService,
        private jwtService: JwtService,
    ) { }

    async validateUser(email: string, pass: string): Promise<any> {
        const user = await this.usersService.findByEmail(email);
        if (user && (await bcrypt.compare(pass, user.passwordHash))) {
            const { passwordHash, ...result } = user;
            return result;
        }
        return null;
    }

    async login(user: any) {
        const payload = { email: user.email, sub: user.id, role: user.role };
        return {
            access_token: this.jwtService.sign(payload),
            user: user,
        };
    }

    async register(createUserDto: CreateUserDto) {
        return this.usersService.create(createUserDto);
    }

    async initiateMobileLogin(phone: string) {
        const user = await this.usersService.findByPhone(phone);
        if (!user) {
            return null; // Controller will handle 404/Unauthorized
        }
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

    async verifyMobileLogin(phone: string, code: string) {
        // 1. Verify OTP (Mock for now)
        // In production, verify against Redis/DB
        if (code !== '123456') { // Mock OTP
            throw new UnauthorizedException('Invalid verification code');
        }

        // 2. Find User
        const user = await this.usersService.findByPhone(phone);
        if (!user) {
            throw new UnauthorizedException('User not found');
        }

        // 3. Generate Token (Same as email login)
        return this.login(user); // Reuses the existing login method which signs the JWT
    }

    async getUserProfile(userId: string) {
        const user = await this.usersService.findById(userId);
        if (!user) return null;
        // Return safe user object
        const { passwordHash, otpCode, otpExpiresAt, ...result } = user;
        return result;
    }
}
