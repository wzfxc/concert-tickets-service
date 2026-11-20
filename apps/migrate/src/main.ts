import pg from 'pg';
import { migrate, seed, waitForDb } from './migrate.js';

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'], max: 2 });
  try {
    await waitForDb(pool);
    await migrate(pool);
    if (process.argv.includes('--seed')) await seed(pool);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
