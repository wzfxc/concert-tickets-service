import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { ERROR_CODES } from '@tickets/shared';

const ERROR_RESPONSES: Record<string, string> = {
  '400': 'VALIDATION_ERROR, IDEMPOTENCY_KEY_REQUIRED',
  '401': 'UNAUTHORIZED',
  '403':
    'FORBIDDEN, INVALID_SIGNATURE, TICKET_TRANSFERRED, TICKET_REFUNDED, OTHER_EVENT, ALREADY_USED',
  '404': 'NOT_FOUND, TICKET_NOT_FOUND',
  '409':
    'SEATS_UNAVAILABLE, PER_USER_LIMIT, HOLD_EXPIRED, PROMO_EXHAUSTED, REFUND_EXCEEDS_PAID, REFUND_WINDOW_CLOSED, EVENT_CANCELLED, EVENT_NOT_ON_SALE, QUEUE_REQUIRED, SEAT_OFFERED, TRANSFER_TOO_LATE, INVALID_STATE, CONFLICT',
  '422': 'IDEMPOTENCY_KEY_REUSED, PROMO_INVALID',
  '429': 'RATE_LIMITED',
  '500': 'INTERNAL',
  '503': 'SERVICE_UNAVAILABLE',
};

/**
 * Builds the OpenAPI document. Every operation gets the shared `ApiError` envelope for 4xx/5xx and the
 * `ErrorCode` enum is part of the schema, so the generated client knows every code (invariant 15).
 */
export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Concert Tickets API')
    .setDescription(
      'Concert ticket sales: events, seat holds, orders, payments (stub), refunds, transfers, gates, finance.',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const doc = SwaggerModule.createDocument(app, config);
  doc.components ??= {};
  doc.components.schemas ??= {};
  doc.components.schemas['ErrorCode'] = { type: 'string', enum: [...ERROR_CODES] };
  doc.components.schemas['ApiError'] = {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message', 'requestId'],
        properties: {
          code: { $ref: '#/components/schemas/ErrorCode' },
          message: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
          requestId: { type: 'string' },
        },
      },
    },
  };
  for (const path of Object.values(doc.paths)) {
    for (const op of Object.values(path)) {
      if (!op || typeof op !== 'object' || !('responses' in op)) continue;
      const responses = (op as { responses: Record<string, unknown> }).responses;
      for (const [status, codes] of Object.entries(ERROR_RESPONSES)) {
        responses[status] ??= {
          description: `Error: ${codes}`,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        };
      }
    }
  }
  return doc;
}

export function mountSwagger(app: INestApplication): OpenAPIObject {
  const doc = buildOpenApi(app);
  SwaggerModule.setup('docs', app, doc, { jsonDocumentUrl: 'docs-json' });
  return doc;
}
