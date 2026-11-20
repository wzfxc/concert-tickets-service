import pg from 'pg';
import { applyMigrations, waitForDb } from '../../apps/migrate/src/migrate.ts';

const DB_NAME = 'tickets_it';

function adminUrl(): string {
  const base =
    process.env['TEST_PG_ADMIN_URL'] ??
    process.env['DATABASE_URL']?.replace(/@postgres:/, '@localhost:') ??
    'postgresql://tickets:tickets_dev_password@localhost:5432/postgres';
  const u = new URL(base);
  u.pathname = '/postgres';
  return u.toString();
}

export function testDbUrl(): string {
  const u = new URL(adminUrl());
  u.pathname = `/${DB_NAME}`;
  return u.toString();
}

/** Fresh database per run, migrated with the real Prisma migrations (`prisma migrate deploy`). */
export default async function setup(): Promise<void> {
  const admin = new pg.Pool({ connectionString: adminUrl(), max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
  await waitForDb(testDbUrl());
  await applyMigrations(testDbUrl());
  process.env['TEST_DATABASE_URL'] = testDbUrl();
}
