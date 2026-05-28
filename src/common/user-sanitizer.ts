import { User } from '@prisma/client';

const SENSITIVE_USER_FIELDS = [
  'passwordHash',
  'stripeCustomerId',
  'stripeAccountId',
  'recoveryStatus',
] as const;

export type SafeUser = Omit<User, 'passwordHash'> & {
  storeId?: string | null;
  store?: unknown;
};

export function sanitizeUser<T extends Record<string, unknown>>(
  user: T,
  options?: { includeFinancial?: boolean },
): Omit<T, 'passwordHash'> {
  if (!user) return user;
  const { passwordHash: _ph, ...rest } = user as T & { passwordHash?: string };
  if (!options?.includeFinancial) {
    for (const key of SENSITIVE_USER_FIELDS) {
      if (key !== 'passwordHash' && key in rest) {
        delete (rest as Record<string, unknown>)[key];
      }
    }
  }
  return rest;
}

export function isAdminRole(role: string | undefined | null): boolean {
  const r = (role ?? '').toUpperCase();
  return r === 'ADMIN' || r === 'SUPER_ADMIN' || r === 'SUPPORT';
}
