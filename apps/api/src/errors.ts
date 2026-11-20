import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
  type NestMiddleware,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { dbErrorCode } from '@tickets/db';
import type { ErrorCode } from '@tickets/shared';

export const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SEATS_UNAVAILABLE: 409,
  PER_USER_LIMIT: 409,
  HOLD_EXPIRED: 409,
  PROMO_EXHAUSTED: 409,
  PROMO_INVALID: 422,
  REFUND_EXCEEDS_PAID: 409,
  REFUND_WINDOW_CLOSED: 409,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_REUSED: 422,
  EVENT_CANCELLED: 409,
  EVENT_NOT_ON_SALE: 409,
  QUEUE_REQUIRED: 409,
  SEAT_OFFERED: 409,
  TRANSFER_TOO_LATE: 409,
  INVALID_SIGNATURE: 403,
  TICKET_TRANSFERRED: 403,
  TICKET_REFUNDED: 403,
  OTHER_EVENT: 403,
  ALREADY_USED: 403,
  RATE_LIMITED: 429,
  INVALID_STATE: 409,
  CONFLICT: 409,
  TICKET_NOT_FOUND: 404,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500,
};

/** Domain error: always rendered as `{ error: { code, message, details?, requestId } }`. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details?: Record<string, unknown>,
    readonly statusOverride?: number,
  ) {
    super(message ?? code);
  }
  get status(): number {
    return this.statusOverride ?? HTTP_STATUS[this.code];
  }
}

export interface RequestWithId extends Request {
  requestId?: string;
}

export class RequestIdMiddleware implements NestMiddleware {
  use(req: RequestWithId, res: Response, next: NextFunction): void {
    const incoming = req.header('x-request-id');
    req.requestId = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.requestId);
    next();
  }
}

function fromStatus(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'SERVICE_UNAVAILABLE';
  if (status >= 400 && status < 500) return 'VALIDATION_ERROR';
  return 'INTERNAL';
}

const FIXED_MESSAGES: Partial<Record<ErrorCode, string>> = {
  INTERNAL: 'Unexpected server error',
  SERVICE_UNAVAILABLE: 'Service temporarily unavailable',
};

function isPoolTimeout(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${String(err.cause ?? '')}` : '';
  return /P2024|timed out fetching a new connection|timeout exceeded when trying to connect/i.test(
    text,
  );
}

/** Single error format for every endpoint. Unknown errors never leak their text (logged server-side). */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<RequestWithId>();
    const res = http.getResponse<Response>();
    const requestId = req.requestId ?? randomUUID();
    let code: ErrorCode = 'INTERNAL';
    let status = 500;
    let message: string | undefined;
    let details: Record<string, unknown> | undefined;

    if (exception instanceof AppError) {
      code = exception.code;
      status = exception.status;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof ZodError) {
      code = 'VALIDATION_ERROR';
      status = 400;
      message = 'Invalid input';
      details = {
        issues: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = fromStatus(status);
      message = status < 500 ? exception.message : undefined;
    } else {
      const dbCode = dbErrorCode(exception);
      const maybe = exception as { status?: unknown; statusCode?: unknown } | null;
      const httpStatus = Number(maybe?.status ?? maybe?.statusCode);
      if (dbCode && dbCode in HTTP_STATUS) {
        code = dbCode as ErrorCode;
        status = HTTP_STATUS[code];
      } else if (isPoolTimeout(exception)) {
        // Connection pool exhausted: a coded, retryable 503 instead of an opaque 500.
        code = 'SERVICE_UNAVAILABLE';
        status = 503;
        this.logger.warn(`request ${requestId}: database pool timeout`);
      } else if (httpStatus >= 400 && httpStatus < 500) {
        // body-parser / framework client errors (malformed JSON, payload too large, ...)
        status = httpStatus;
        code = fromStatus(status);
        message = 'Malformed request';
      } else {
        this.logger.error(
          `request ${requestId} failed`,
          exception instanceof Error ? exception.stack : String(exception),
        );
      }
    }
    if (status >= 500) message = FIXED_MESSAGES[code] ?? FIXED_MESSAGES['INTERNAL'];
    res.status(status).json({
      error: { code, message: message ?? code, ...(details ? { details } : {}), requestId },
    });
  }
}
