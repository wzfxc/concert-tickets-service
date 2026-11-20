import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
export default {
  // Standalone output (used by docker/web.Dockerfile) needs symlinks, which Windows shells may forbid.
  ...(process.env['NEXT_STANDALONE'] === '1' ? { output: 'standalone' } : {}),
  outputFileTracingRoot: path.join(here, '../..'),
};
