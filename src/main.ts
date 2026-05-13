import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';

function resolveCorsOrigins(): string[] | boolean {
    const raw = process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '';
    if (!raw.trim()) return true;
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return list.length ? list : true;
}

function isAllowedLocalDevOrigin(origin: string): boolean {
    try {
        const { hostname } = new URL(origin);

        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') {
            return true;
        }

        const octets = hostname.split('.').map(Number);
        if (octets.length !== 4 || octets.some(Number.isNaN)) {
            return false;
        }

        const [first, second] = octets;
        return (
            first === 10 ||
            (first === 172 && second >= 16 && second <= 31) ||
            (first === 192 && second === 168)
        );
    } catch {
        return false;
    }
}

async function bootstrap() {
    const app = await NestFactory.create(AppModule, { rawBody: true });

    app.use(helmet());

    // Enable Global Validation
    app.useGlobalPipes(new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
    }));

    const corsOrigin = resolveCorsOrigins();
    const isProduction = process.env.NODE_ENV === 'production';
    app.enableCors({
        origin: (origin, callback) => {
            if (!origin || corsOrigin === true) {
                callback(null, true);
                return;
            }

            if (Array.isArray(corsOrigin) && corsOrigin.includes(origin)) {
                callback(null, origin);
                return;
            }

            if (!isProduction && isAllowedLocalDevOrigin(origin)) {
                callback(null, origin);
                return;
            }

            callback(new Error(`Origin ${origin} not allowed by CORS`), false);
        },
        methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
        credentials: true,
    });
    const port = process.env.PORT || 3000;
    await app.listen(port, '0.0.0.0');
    console.log(`Server running on port ${port}`);
}
bootstrap();
