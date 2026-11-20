import createClient from 'openapi-fetch';
import type { ErrorCode } from '@tickets/shared';
import type { paths } from '../api/schema';

const TOKEN_KEY = 'tickets.token';
const USER_KEY = 'tickets.user';

export interface StoredUser {
  id: string;
  email: string;
  name: string;
  role: 'buyer' | 'organizer' | 'controller' | 'finance';
  locale: 'uk' | 'en' | 'pl';
}

export const tokenStore = {
  get: (): string | null =>
    typeof window === 'undefined' ? null : window.localStorage.getItem(TOKEN_KEY),
  user: (): StoredUser | null => {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as StoredUser) : null;
  },
  set: (token: string, user: StoredUser): void => {
    window.localStorage.setItem(TOKEN_KEY, token);
    window.localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear: (): void => {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
  },
};

/** Same-origin by default (nginx routes /api to the api instances); NEXT_PUBLIC_API_URL for local dev. */
export const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? '';

/** Typed client generated from OpenAPI (`pnpm gen:client`); the Authorization header is read per request. */
export const api = createClient<paths>({
  baseUrl: API_BASE,
  fetch: (req: Request) => {
    const token = tokenStore.get();
    if (token) req.headers.set('authorization', `Bearer ${token}`);
    return fetch(req);
  },
});

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
  /** Field-level problems from Zod validation: path → message. */
  get issues(): { path: string; message: string }[] {
    const issues = this.details?.['issues'];
    return Array.isArray(issues) ? (issues as { path: string; message: string }[]) : [];
  }
}

interface Envelope {
  error?: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

/** Unwraps an openapi-fetch result: data on success, a coded ApiError otherwise (the single error format). */
export function unwrap<T>(res: { data?: T; error?: unknown; response: Response }): T {
  if (res.data !== undefined) return res.data;
  const env = res.error as Envelope | undefined;
  throw new ApiError(
    env?.error?.code ?? 'INTERNAL',
    env?.error?.message ?? 'Request failed',
    res.response.status,
    env?.error?.details,
  );
}

export const newKey = (): string => crypto.randomUUID();
