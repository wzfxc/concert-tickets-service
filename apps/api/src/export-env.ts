// Imported first by export-openapi.ts: placeholders so the exporter never needs real infrastructure
// (Prisma and Redis connect lazily, so no connection is ever attempted).
process.env['DATABASE_URL'] ??= 'postgresql://openapi:openapi@127.0.0.1:1/openapi';
process.env['JWT_SECRET'] ??= 'openapi-export';
process.env['QR_SIGNING_SECRET'] ??= 'openapi-export';
process.env['PAYMENT_WEBHOOK_SECRET'] ??= 'openapi-export';
process.env['REDIS_URL'] ??= 'redis://127.0.0.1:1';
process.env['ENABLE_TEST_CONTROLS'] = 'false';
