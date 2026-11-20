import './export-env.js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createApp } from './bootstrap.js';
import { buildOpenApi } from './openapi.js';

/** `pnpm --filter @tickets/api export:openapi` → openapi.json at the repo root (input of the web client generator). */
async function main(): Promise<void> {
  const app = await createApp({ logger: false });
  const doc = buildOpenApi(app);
  const target = path.resolve(process.argv[2] ?? '../../openapi.json');
  writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`openapi written to ${target}`);
  await app.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
