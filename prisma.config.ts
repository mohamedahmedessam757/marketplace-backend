import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Supabase + Prisma 7:
 * - Runtime app uses DATABASE_URL (transaction pooler :6543 + pgbouncer).
 * - Migrations need a direct/session connection (:5432, no pgbouncer).
 * - Legacy `db.<ref>.supabase.co` often does not resolve (ENOTFOUND); use session pooler instead.
 */
function ensureSslParams(url: string): string {
  const parsed = new URL(url);
  if (!parsed.searchParams.has('sslmode')) {
    parsed.searchParams.set('sslmode', 'require');
  }
  if (!parsed.searchParams.has('uselibpqcompat')) {
    parsed.searchParams.set('uselibpqcompat', 'true');
  }
  return parsed.toString();
}

function isLegacySupabaseDirectHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.startsWith('db.') && host.endsWith('.supabase.co');
  } catch {
    return false;
  }
}

function toSupabaseSessionUrl(poolerUrl: string): string {
  const parsed = new URL(poolerUrl);
  parsed.port = '5432';
  parsed.searchParams.delete('pgbouncer');
  return ensureSslParams(parsed.toString());
}

function resolveMigrationUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const directUrl = process.env.DIRECT_URL?.trim();

  if (directUrl && !isLegacySupabaseDirectHost(directUrl)) {
    return ensureSslParams(directUrl);
  }

  if (databaseUrl?.includes('pooler.supabase.com')) {
    return toSupabaseSessionUrl(databaseUrl);
  }

  if (directUrl) {
    return ensureSslParams(directUrl);
  }

  if (databaseUrl) {
    return ensureSslParams(databaseUrl);
  }

  throw new Error(
    'Set DATABASE_URL (and optionally DIRECT_URL) in backend/.env for Prisma CLI',
  );
}

const migrationUrl = resolveMigrationUrl();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: migrationUrl,
  },
});
