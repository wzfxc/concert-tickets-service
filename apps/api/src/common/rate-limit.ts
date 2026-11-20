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

/** IPv6 clients are keyed by their /64 (one subscriber gets a whole /64, so rotating the low bits must not evade limits). */
export function normalizeIp(raw: string): string {
  const ip = raw.replace(/^::ffff:/i, '');
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.split('::');
  const groups = head.split(':').filter(Boolean);
  if (ip.includes('::'))
    groups.push(
      ...Array<string>(
        Math.max(0, 8 - groups.length - tail.split(':').filter(Boolean).length),
      ).fill('0'),
      ...tail.split(':').filter(Boolean),
    );
  return (
    groups
      .slice(0, 4)
      .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
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
