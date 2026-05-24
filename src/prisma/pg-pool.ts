import { Pool, PoolConfig } from 'pg';

function isSupabaseUrl(connectionString: string): boolean {
    return (
        connectionString.includes('supabase.co') ||
        connectionString.includes('pooler.supabase.com')
    );
}

/** Remove sslmode from URL — pg v8 treats it as strict verify-full and ignores Pool.ssl. */
function normalizeDatabaseUrl(connectionString: string): string {
    try {
        const url = new URL(connectionString);
        url.searchParams.delete('sslmode');
        url.searchParams.delete('ssl');
        return url.toString();
    } catch {
        return connectionString
            .replace(/([?&])sslmode=[^&]*&?/g, '$1')
            .replace(/([?&])ssl=[^&]*&?/g, '$1')
            .replace(/[?&]$/, '');
    }
}

export function createDatabasePool(connectionString = process.env.DATABASE_URL): Pool {
    if (!connectionString) {
        throw new Error('DATABASE_URL is not configured');
    }

    const isSupabase = isSupabaseUrl(connectionString);
    const config: PoolConfig = {
        connectionString: normalizeDatabaseUrl(connectionString),
        max: 10,
        connectionTimeoutMillis: 5000,
    };

    if (isSupabase) {
        config.ssl = { rejectUnauthorized: false };
    }

    return new Pool(config);
}
