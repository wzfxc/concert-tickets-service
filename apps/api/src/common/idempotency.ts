import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { IdempotencyKeySchema } from '@tickets/shared';
import { AppError } from '@tickets/domain';
import { PrismaService } from './infra.js';

/** JSON with sorted keys so semantically equal bodies hash equally. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

const IN_FLIGHT_WAIT_MS = 15_000;
const STALE_IN_FLIGHT_MS = 60_000;

interface KeyRow {
  request_hash: string;
  response: unknown;
  has_response: boolean;
  age_ms: number;
}

/**
 * Invariant 6: the same (scope, key) returns one stored result; the same key with another body is
 * rejected. State lives in Postgres (`idempotency_keys`), so it works across both api instances and
 * survives a Redis flush. Failed executions release the key so the client may retry.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async run<T>(
    scope: string,
    rawKey: string | undefined,
    body: unknown,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!rawKey)
      throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    const parsed = IdempotencyKeySchema.safeParse(rawKey);
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Invalid Idempotency-Key');
    const key = parsed.data;
    const hash = createHash('sha256').update(stableStringify(body)).digest('hex');
    const db = this.prisma.db;
    const deadline = new Date().getTime() + IN_FLIGHT_WAIT_MS;

    for (;;) {
      const inserted = await db.$executeRaw`
        INSERT INTO idempotency_keys (scope, key, request_hash) VALUES (${scope}, ${key}, ${hash})
        ON CONFLICT (scope, key) DO NOTHING`;
      if (inserted === 1) {
        try {
          const result = await fn();
          await db.$executeRaw`
            UPDATE idempotency_keys SET status_code = 200, response = ${JSON.stringify(result ?? null)}::jsonb
            WHERE scope = ${scope} AND key = ${key}`;
          return result;
        } catch (err) {
          await db.$executeRaw`DELETE FROM idempotency_keys WHERE scope = ${scope} AND key = ${key}`;
          throw err;
        }
      }
      const rows = await db.$queryRaw<KeyRow[]>`
        SELECT request_hash, response, (status_code IS NOT NULL) AS has_response,
               (extract(epoch FROM (clock_timestamp() - created_at)) * 1000)::float8 AS age_ms
        FROM idempotency_keys WHERE scope = ${scope} AND key = ${key}`;
      const row = rows[0];
      if (!row) continue; // released between our insert and select: try again
      if (row.request_hash !== hash) {
        throw new AppError(
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key was already used with a different request body',
        );
      }
      if (row.has_response) return row.response as T;
      if (row.age_ms > STALE_IN_FLIGHT_MS) {
        // The original attempt died without finishing (e.g. process killed): take the key over.
        await db.$executeRaw`
          DELETE FROM idempotency_keys WHERE scope = ${scope} AND key = ${key} AND status_code IS NULL`;
        continue;
      }
      if (new Date().getTime() > deadline) {
        throw new AppError(
          'CONFLICT',
          'A request with this Idempotency-Key is still being processed',
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
