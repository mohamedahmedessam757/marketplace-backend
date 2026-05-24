import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './client';
import { createDatabasePool } from './pg-pool';

const CONNECT_MAX_RETRIES = 5;
const CONNECT_BASE_DELAY_MS = 2000;

function createStandalonePrismaClient(options?: { log?: ('warn' | 'error' | 'info' | 'query')[] }) {
    const pool = createDatabasePool();

    return new PrismaClient({
        adapter: new PrismaPg(pool),
        log: options?.log ?? ['error'],
    });
}

export { createStandalonePrismaClient };
