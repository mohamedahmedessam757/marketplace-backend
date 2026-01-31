import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor(
        private configService: ConfigService,
        private usersService: UsersService,
    ) {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey: configService.get<string>('JWT_SECRET'),
        });
    }

    async validate(payload: any) {
        // payload = { sub: userId, email: ... }
        const user = await this.usersService.findByIdWithStore(payload.sub);
        if (!user) {
            throw new UnauthorizedException();
        }

        // For VENDOR users, attach storeId directly to user object for easy access
        const userWithStoreId = {
            ...user,
            storeId: user.store?.id || null
        };

        // Return user object, which will be injected into Request object
        return userWithStoreId;
    }
}
