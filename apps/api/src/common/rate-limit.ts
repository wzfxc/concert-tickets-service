import { isIP } from 'node:net';
import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { AppError } from '@tickets/domain';
import { config } from './config.js';
import { RedisService } from './infra.js';
import type { AppRequest } from './route.js';

interface Window {
  count: number;
  resetAt: number;
}

const HIT_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {c, redis.call('PTTL', KEYS[1])}`;

// Failure counter + exponential lock: threshold failures lock for base ms, every further failure doubles it (capped).
const FAIL_LUA = `
local c = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
local over = c - tonumber(ARGV[1])
if over >= 0 then
  local ms = math.min(tonumber(ARGV[2]) * (2 ^ math.min(over, 30)), tonumber(ARGV[3]))
  redis.call('SET', KEYS[2], '1', 'PX', math.floor(ms))
  return math.floor(ms)
end
return 0`;

/**
 * Redis-backed counters (shared by both api instances, expiry by Redis TTL so no Node wall clock is involved).
 * If Redis is unavailable the same logic runs on a per-instance in-memory map (monotonic `performance.now()`),
 * so protection degrades instead of disappearing (and requests are never failed because of Redis).
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger('RateLimit');
  private readonly windows = new Map<string, Window>();
  private readonly fails = new Map<string, { count: number; expiresAt: number }>();
  private readonly locks = new Map<string, number>();

  constructor(private readonly redis: RedisService) {}

  private now(): number {
    return performance.now();
  }

  private sweep(): void {
    if (this.windows.size + this.fails.size + this.locks.size < 50_000) return;
    const t = this.now();
    for (const [k, w] of this.windows) if (w.resetAt <= t) this.windows.delete(k);
    for (const [k, f] of this.fails) if (f.expiresAt <= t) this.fails.delete(k);
    for (const [k, until] of this.locks) if (until <= t) this.locks.delete(k);
  }

  /** Fixed-window counter. Returns the seconds to wait when the limit is exceeded, otherwise 0. */
  async hit(key: string, limit: number, windowMs: number): Promise<number> {
    let count: number;
    let ttl: number;
    try {
      const r = (await this.redis.client.eval(HIT_LUA, 1, `rl:${key}`, windowMs)) as [
        number,
        number,
      ];
      [count, ttl] = r;
    } catch (err) {
      this.logger.warn(`redis unavailable, using in-memory limiter: ${(err as Error).message}`);
      this.sweep();
      const t = this.now();
      let w = this.windows.get(key);
      if (!w || w.resetAt <= t) {
        w = { count: 0, resetAt: t + windowMs };
        this.windows.set(key, w);
      }
      w.count += 1;
      count = w.count;
      ttl = w.resetAt - t;
    }
    return count > limit ? Math.max(1, Math.ceil(ttl / 1000)) : 0;
  }

  /** Seconds the key is still locked (0 = free). */
  async lockedFor(key: string): Promise<number> {
    try {
      const ms = await this.redis.client.pttl(`bf:lock:${key}`);
      return ms > 0 ? Math.ceil(ms / 1000) : 0;
    } catch {
      const until = this.locks.get(key) ?? 0;
      const left = until - this.now();
      return left > 0 ? Math.ceil(left / 1000) : 0;
    }
  }

  async recordFailure(key: string, threshold: number): Promise<void> {
    const { bfBaseLockMs: base, bfMaxLockMs: max, bfFailWindowMs: win } = config;
    try {
      await this.redis.client.eval(
        FAIL_LUA,
        2,
        `bf:fail:${key}`,
        `bf:lock:${key}`,
        threshold,
        base,
        max,
        win,
      );
    } catch {
      this.sweep();
      const t = this.now();
      const cur = this.fails.get(key);
      const count = (cur && cur.expiresAt > t ? cur.count : 0) + 1;
      this.fails.set(key, { count, expiresAt: t + win });
      const over = count - threshold;
      if (over >= 0) this.locks.set(key, t + Math.min(base * 2 ** Math.min(over, 30), max));
    }
  }

  async reset(key: string): Promise<void> {
    this.fails.delete(key);
    this.locks.delete(key);
    await this.redis.client.del(`bf:fail:${key}`, `bf:lock:${key}`).catch(() => 0);
  }
}

interface Policy {
  name: string;
  method: string;
  path: RegExp;
  limit: number;
  /** `ip` for unauthenticated endpoints, otherwise the user id (falls back to the ip). */
  by: 'ip' | 'user';
}

// Sensitive endpoints first (first match wins), generous default last.
const POLICIES: Policy[] = [
  {
    name: 'auth',
    method: 'POST',
    path: /^\/api\/auth\/(login|register)$/,
    limit: 30,
    by: 'ip',
  },
  { name: 'holds', method: 'POST', path: /^\/api\/holds$/, limit: 30, by: 'user' },
  {
    name: 'payments',
    method: 'POST',
    path: /^\/api\/payments$/,
    limit: 20,
    by: 'user',
  },
  {
    name: 'queue',
    method: 'POST',
    path: /^\/api\/events\/[^/]+\/(queue|waitlist)$/,
    limit: 30,
    by: 'user',
  },
  {
    name: 'uploads',
    method: 'POST',
    path: /^\/api\/venues$/,
    limit: 10,
    by: 'user',
  },
];
const EXEMPT = /^\/(api\/health|api\/payments\/webhook|stub-pay|__test)(\/|$)/;

/** Expands an IPv6 literal (with optional embedded dotted IPv4 tail) to 8 hextets, or null if it is not valid. */
function expandIpv6(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let text = ip.split('%')[0] ?? ip;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const o = (dotted[1] ?? '').split('.').map(Number);
    text =
      text.slice(0, -(dotted[1] ?? '').length) +
      ((o[0]! << 8) | o[1]!).toString(16) +
      ':' +
      ((o[2]! << 8) | o[3]!).toString(16);
  }
  const [head = '', tail, extra] = text.split('::');
  if (extra !== undefined) return null;
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  if (fill < 0 || (tail === undefined && h.length !== 8)) return null;
  const groups = [...h, ...Array<string>(fill).fill('0'), ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

/**
 * Rate-limit identity of a client address: IPv4 stays as is; every IPv6 form that embeds an IPv4 address
 * (IPv4-mapped in any spelling, IPv4-compatible, NAT64 64:ff9b::/96) is keyed by that IPv4; genuine native IPv6 is
 * keyed by its /64 (rotating the low 64 bits must not evade limits); anything unparseable keeps its raw text.
 */
export function normalizeIp(raw: string): string {
  const g = expandIpv6(raw);
  if (!g) return raw;
  const v4 = (): string => [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255].join('.');
  const zeros = (n: number): boolean => g.slice(0, n).every((x) => x === 0);
  if ((zeros(5) && g[5] === 0xffff) || (zeros(6) && (g[6] !== 0 || g[7]! > 1))) return v4();
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4();
  return (
    g
      .slice(0, 4)
      .map((x) => x.toString(16))
      .join(':') + '::/64'
  );
}

export function clientIp(req: AppRequest): string {
  return normalizeIp(req.ip ?? req.socket?.remoteAddress ?? 'unknown');
}

/** Global limiter. Runs after `AuthGuard` (registered later), so authenticated callers are limited per user. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly limiter: RateLimitService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http' || !config.rateLimitEnabled) return true;
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const path = req.path;
    if (EXEMPT.test(path)) return true;
    const policy = POLICIES.find((p) => p.method === req.method && p.path.test(path));
    const who = policy?.by === 'ip' ? clientIp(req) : req.user ? `u:${req.user.id}` : clientIp(req);
    const name = policy?.name ?? 'default';
    const limit = policy ? policy.limit : config.rateLimitDefaultPerMin;
    const retry = await this.limiter.hit(`${name}:${who}`, limit, config.rateLimitWindowMs);
    if (retry > 0) {
      throw new AppError('RATE_LIMITED', 'Too many requests, retry later', {
        retryAfterSec: retry,
      });
    }
    return true;
  }
}
