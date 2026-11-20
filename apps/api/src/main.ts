import { createApp } from './bootstrap.js';
import { config } from './common/config.js';
import { mountSwagger } from './openapi.js';

async function main(): Promise<void> {
  const app = await createApp();
  mountSwagger(app);
  await app.listen(config.port, '0.0.0.0');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
