import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import createNextIntlPlugin from 'next-intl/plugin';

const here = path.dirname(fileURLToPath(import.meta.url));
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** @type {import('next').NextConfig} */
const config = {
  // Standalone output (used by docker/web.Dockerfile) needs symlinks, which Windows shells may forbid.
  ...(process.env['NEXT_STANDALONE'] === '1' ? { output: 'standalone' } : {}),
  outputFileTracingRoot: path.join(here, '../..'),
};

export default withNextIntl(config);
