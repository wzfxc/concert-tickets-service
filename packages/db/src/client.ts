import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

export type { Prisma } from './generated/client.js';

/** Prisma client over the pg driver adapter. Pass `max` to size the underlying pool. */
export function createPrismaClient(connectionString: string, max = 10): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString, max }) });
}
