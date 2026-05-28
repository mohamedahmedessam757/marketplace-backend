export function validateProductionEnv(): void {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) return;

  const jwtSecret = process.env.JWT_SECRET?.trim();
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters in production');
  }

  const cors = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '').trim();
  if (!cors) {
    throw new Error('CORS_ORIGINS or FRONTEND_URL must be set in production');
  }

  if (process.env.ALLOW_MOCK_PAYMENTS === 'true') {
    throw new Error('ALLOW_MOCK_PAYMENTS must not be true in production');
  }
}
