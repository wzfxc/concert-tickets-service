import { createHmac, timingSafeEqual } from 'node:crypto';
import { USER_ROLES, type UserRole } from '@tickets/shared';
import { config } from './config.js';

export interface AuthUser {
  id: string;
  role: UserRole;
}

const TOKEN_TTL_S = 12 * 3600;

const encode = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const mac = (data: string): string =>
  createHmac('sha256', config.jwtSecret).update(data).digest('base64url');
const nowSeconds = (): number => Math.floor(new Date().getTime() / 1000);

/** Minimal HS256 JWT (header.payload.signature); verified in constant time. */
export function signJwt(user: AuthUser): string {
  const head = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({ sub: user.id, role: user.role, exp: nowSeconds() + TOKEN_TTL_S });
  return `${head}.${body}.${mac(`${head}.${body}`)}`;
}

export function verifyJwt(token: string): AuthUser | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  const expected = Buffer.from(mac(`${head}.${body}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      sub?: unknown;
      role?: unknown;
      exp?: unknown;
    };
    if (typeof p.sub !== 'string' || typeof p.exp !== 'number') return null;
    if (p.exp < nowSeconds()) return null;
    if (!USER_ROLES.includes(p.role as UserRole)) return null;
    return { id: p.sub, role: p.role as UserRole };
  } catch {
    return null;
  }
}
