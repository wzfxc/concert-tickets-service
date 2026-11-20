import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import pg from 'pg';
import { seedBulk } from './seed.js';

const require = createRequire(import.meta.url);

export async function waitForDb(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await pool.query('SELECT 1');
        return;
      } catch (err) {
        if (attempt >= 30) throw err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  } finally {
    await pool.end();
  }
}

/**
 * Applies Prisma migrations (`prisma migrate deploy`). The raw-SQL invariants (triggers, functions,
 * partial indexes) are part of those migrations, so one command brings the DB fully up to date.
 * Prisma takes its own advisory lock, so concurrent runners are safe.
 */
export async function applyMigrations(databaseUrl: string): Promise<void> {
  const dbPkg = require.resolve('@tickets/db/package.json');
  const dbDir = path.dirname(dbPkg);
  const prismaBin = createRequire(dbPkg).resolve('prisma/build/index.js');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [prismaBin, 'migrate', 'deploy', '--config', path.join(dbDir, 'prisma.config.ts')],
      { cwd: dbDir, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'inherit' },
    );
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`prisma migrate deploy exited with ${code}`)),
    );
  });
}

export async function seed(databaseUrl: string): Promise<void> {
  await seedBulk(databaseUrl, process.env['SEED_PASSWORD'] ?? 'Passw0rd!');
}
