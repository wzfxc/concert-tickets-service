import { QUEUE_MAX_SELECTORS, STUB_MAX_RPS } from '@tickets/shared';

function num(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return process.env[name] && Number.isFinite(n) ? n : fallback;
}

/** All configuration comes from the environment (see .env.example). */
export const config = {
  port: num('PORT', 3100),
  databaseUrl: process.env['DATABASE_URL'] ?? '',
  redisUrl: process.env['REDIS_URL'] || 'redis://localhost:6379',
  qrSecret: process.env['QR_SIGNING_SECRET'] ?? '',
  smtpHost: process.env['SMTP_HOST'] || 'localhost',
  smtpPort: num('SMTP_PORT', 1025),
  mailFrom: process.env['MAIL_FROM'] || 'tickets@example.test',
  /** The provider stub is reached over HTTP through nginx/any api instance. */
  stubBaseUrl: process.env['STUB_BASE_URL'] || 'http://nginx',
  stubRps: num('PAYMENT_STUB_RPS', STUB_MAX_RPS),
  queueMaxSelectors: num('QUEUE_MAX_SELECTORS', QUEUE_MAX_SELECTORS),
  tickMs: num('WORKER_TICK_MS', 2000),
  reconcileMs: num('RECONCILE_INTERVAL_MS', 60_000),
  dbPoolSize: num('DB_POOL_SIZE', 10),
};
