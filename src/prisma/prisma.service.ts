import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

const CONNECT_MAX_RETRIES = 5;
const CONNECT_BASE_DELAY_MS = 2000;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PrismaService.name);

    constructor() {
        super({
            log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
        });
    }

    async onModuleInit() {
        await this.connectWithRetry();
    }

    async onModuleDestroy() {
        await this.$disconnect();
    }

    /** Lightweight ping — used by health checks and reconnect logic. */
    async isHealthy(): Promise<boolean> {
        try {
            await this.$queryRaw`SELECT 1`;
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Re-establish the pool after transient Supabase pooler blips (P1001).
     * Safe to call from guards / schedulers before critical queries.
     */
    async ensureConnected(): Promise<boolean> {
        if (await this.isHealthy()) {
            return true;
        }

        this.logger.warn('Database ping failed — attempting reconnect…');
        await this.$disconnect().catch(() => undefined);
        await this.connectWithRetry();
        return this.isHealthy();
    }

    private async connectWithRetry(attempt = 1): Promise<void> {
        try {
            await this.$connect();
            this.logger.log('Database connected');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            const isLast = attempt >= CONNECT_MAX_RETRIES;

            this.logger.warn(
                `Database connect ${attempt}/${CONNECT_MAX_RETRIES} failed: ${message}`,
            );

            if (isLast) {
                this.logger.error(
                    'Database unreachable after max retries — API will start; retry on next request.',
                );
                return;
            }

            await new Promise((r) => setTimeout(r, CONNECT_BASE_DELAY_MS * attempt));
            return this.connectWithRetry(attempt + 1);
        }
    }
}
