import { Socket } from 'socket.io';

export function socketIoCorsOptions(): { origin: string[] | boolean; credentials: boolean } {
  const raw = process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '';
  if (!raw.trim()) return { origin: true, credentials: true };
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return { origin: list.length ? list : true, credentials: true };
}

export function extractSocketJwt(client: Socket): string | null {
  const auth = client.handshake.auth as { token?: string };
  const headerAuth = client.handshake.headers?.authorization;
  if (auth?.token && typeof auth.token === 'string') return auth.token.trim();
  if (typeof headerAuth === 'string' && headerAuth.startsWith('Bearer ')) {
    return headerAuth.slice(7).trim();
  }
  return null;
}
