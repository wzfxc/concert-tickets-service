import http from 'node:http';
import { Redis } from 'ioredis';
import pg from 'pg';

// Stage 1 skeleton: connectivity + health. Queues/processors arrive in stage 5.
const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'], max: 5 });
const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

const server = http.createServer((req, res) => {
  if (req.url !== '/health') {
    res.writeHead(404).end();
    return;
  }
  Promise.all([pool.query('SELECT 1'), redis.ping()])
    .then(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}'))
    .catch(() => res.writeHead(503).end('{"status":"unhealthy"}'));
});
server.listen(Number(process.env['PORT'] ?? 3100), '0.0.0.0');

async function shutdown(): Promise<void> {
  server.close();
  await Promise.allSettled([pool.end(), redis.quit()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
