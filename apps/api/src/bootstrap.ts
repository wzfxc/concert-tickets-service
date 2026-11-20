import 'reflect-metadata';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AppModule } from './app.module.js';
import { requireSecrets } from './config.js';

// Money and ids are safe integers; JSON must never fail on (or silently stringify) a bigint.
Object.defineProperty(BigInt.prototype, 'toJSON', {
  value(this: bigint): number {
    return Number(this);
  },
  configurable: true,
});

/** Creates the configured Nest app (shared by the server, the OpenAPI exporter and the in-process tests). */
export async function createApp(opts: { logger?: boolean } = {}): Promise<INestApplication> {
  requireSecrets();
  const app = await NestFactory.create(AppModule, {
    rawBody: true, // webhook HMAC is computed over the exact bytes received
    logger: opts.logger === false ? false : ['error', 'warn', 'log'],
  });
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'stub-pay/{*splat}', method: RequestMethod.ALL }, '__test/{*splat}'],
  });
  app.useWebSocketAdapter(new IoAdapter(app));
  app.enableShutdownHooks();
  return app;
}
