import * as path from 'path';
import { addAlias } from 'module-alias';

// Register @prisma/client last — longer @prisma/client/runtime alias must win
addAlias('@prisma/client', path.join(__dirname, 'prisma', 'client'));
addAlias(
  '@prisma/client/runtime',
  path.join(__dirname, '..', '..', 'node_modules', '@prisma', 'client', 'runtime'),
);

import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { GlobalHttpExceptionFilter } from './common/filters/http-exception.filter';
import helmet from 'helmet';
import { validateProductionEnv } from './config/env.validation';

function resolveCorsOrigins(): string[] | boolean {
    const raw = process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '';
    if (!raw.trim()) {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('CORS_ORIGINS must be set in production');
        }
        return true;
    }
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

function parseBodyLimitMb(): string {
    const mb = Number(process.env.JSON_BODY_LIMIT_MB || '35');
    if (!Number.isFinite(mb) || mb < 1) return '35mb';
    return `${Math.min(mb, 100)}mb`;
}

async function bootstrap() {
    validateProductionEnv();
    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
        rawBody: true,
        bodyParser: false,
    });

    const bodyLimit = parseBodyLimitMb();
    app.useBodyParser('json', { limit: bodyLimit });
    app.useBodyParser('urlencoded', { extended: true, limit: bodyLimit });

    app.use(helmet());
    app.useGlobalFilters(new GlobalHttpExceptionFilter());

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
