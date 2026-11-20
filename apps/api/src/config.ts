import { QUEUE_MAX_SELECTORS, QUEUE_TRIGGER_CONTENDERS, STUB_MAX_RPS } from '@tickets/shared';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** All configuration comes from the environment (.env.example documents every key). */
export const config = {
  port: num('PORT', 3000),
  instanceId: process.env['INSTANCE_ID'] || 'api',
  databaseUrl: process.env['DATABASE_URL'] ?? '',
  redisUrl: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
  jwtSecret: process.env['JWT_SECRET'] ?? '',
  qrSecret: process.env['QR_SIGNING_SECRET'] ?? '',
  webhookSecret: process.env['PAYMENT_WEBHOOK_SECRET'] ?? '',
  paymentChaos: (process.env['PAYMENT_CHAOS'] ?? 'off') === 'on',
  paymentChaosScenario: process.env['PAYMENT_CHAOS_SCENARIO'] || 'random',
  stubRps: num('PAYMENT_STUB_RPS', STUB_MAX_RPS),
  /** Fallback bucket when Redis is down: each api instance gets rps / instances. */
  apiInstances: num('API_INSTANCES', 2),
  /** Where the stub reaches the app (webhooks) and where the app reaches the stub. */
  stubBaseUrl: process.env['STUB_BASE_URL'] ?? `http://127.0.0.1:${num('PORT', 3000)}`,
  webhookUrl:
    process.env['WEBHOOK_URL'] ?? `http://127.0.0.1:${num('PORT', 3000)}/api/payments/webhook`,
  publicBaseUrl: process.env['PUBLIC_BASE_URL'] || 'http://localhost:8080',
  testControls: process.env['ENABLE_TEST_CONTROLS'] === 'true',
  queueMaxSelectors: num('QUEUE_MAX_SELECTORS', QUEUE_MAX_SELECTORS),
  queueTrigger: num('QUEUE_TRIGGER_THRESHOLD', QUEUE_TRIGGER_CONTENDERS),
  dbPoolSize: num('DB_POOL_SIZE', 20),
};

export function requireSecrets(): void {
  for (const [k, v] of [
    ['DATABASE_URL', config.databaseUrl],
    ['JWT_SECRET', config.jwtSecret],
    ['QR_SIGNING_SECRET', config.qrSecret],
    ['PAYMENT_WEBHOOK_SECRET', config.webhookSecret],
  ] as const) {
    if (!v) throw new Error(`${k} is required`);
  }
}
