import { applyMigrations, seed, waitForDb } from './migrate.js';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  await waitForDb(url);
  await applyMigrations(url);
  if (process.argv.includes('--seed')) await seed(url);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
