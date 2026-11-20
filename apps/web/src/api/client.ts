import createClient from 'openapi-fetch';
import type { paths } from './schema.js';

/** Typed API client. Types come from the generated `schema.d.ts` (OpenAPI), never written by hand. */
export function createApiClient(baseUrl: string, token?: string) {
  return createClient<paths>({
    baseUrl,
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}
