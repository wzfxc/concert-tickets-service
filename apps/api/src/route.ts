import {
  applyDecorators,
  CallHandler,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { z, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { UserRole } from '@tickets/shared';
import { AppError } from '@tickets/domain';
import { verifyJwt, type AuthUser } from './jwt.js';

export const ROUTE_META = 'route:opts';

export interface RouteOptions {
  summary: string;
  /** Roles allowed (server-side guard). Omit = any authenticated user. */
  roles?: readonly UserRole[];
  public?: boolean;
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  response?: ZodTypeAny;
  status?: number;
  /** Requires the `Idempotency-Key` header (documented in OpenAPI). */
  idempotent?: boolean;
}

type JsonSchema = Record<string, unknown>;

export function toOpenApi(schema: ZodTypeAny): JsonSchema {
  const json = zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' }) as JsonSchema;
  delete json['$schema'];
  return json;
}

/** Declares auth/roles, zod validation (body + query) and OpenAPI docs for one handler. */
export function Route(opts: RouteOptions): MethodDecorator {
  const decorators: MethodDecorator[] = [
    SetMetadata(ROUTE_META, opts) as MethodDecorator,
    ApiOperation({ summary: opts.summary }),
  ];
  if (!opts.public) decorators.push(ApiBearerAuth());
  if (opts.body) decorators.push(ApiBody({ schema: toOpenApi(opts.body) }));
  if (opts.idempotent) {
    decorators.push(
      ApiHeader({
        name: 'Idempotency-Key',
        required: true,
        description: 'Unique key per logical request (8-128 chars)',
      }),
    );
  }
  if (opts.query) {
    const js = toOpenApi(opts.query) as {
      properties?: Record<string, JsonSchema>;
      required?: string[];
    };
    for (const [name, schema] of Object.entries(js.properties ?? {})) {
      decorators.push(ApiQuery({ name, required: js.required?.includes(name) ?? false, schema }));
    }
  }
  decorators.push(
    ApiResponse({
      status: opts.status ?? 200,
      ...(opts.response ? { schema: toOpenApi(opts.response) } : { description: 'OK' }),
    }),
  );
  return applyDecorators(...decorators);
}

export interface AppRequest extends Request {
  requestId?: string;
  user?: AuthUser;
  zodBody?: unknown;
  zodQuery?: unknown;
  rawBody?: Buffer;
}

/** Authentication + role check for every route that is not marked `public` (invariant 14). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return true;
    const opts = this.reflector.get<RouteOptions | undefined>(ROUTE_META, ctx.getHandler());
    if (opts?.public) return true;
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const user = token ? verifyJwt(token) : null;
    if (!user) throw new AppError('UNAUTHORIZED', 'Authentication required');
    req.user = user;
    if (opts?.roles && !opts.roles.includes(user.role)) {
      throw new AppError('FORBIDDEN', 'Your role cannot access this endpoint');
    }
    return true;
  }
}

/** Parses body/query with the route's zod schemas; failures become coded VALIDATION_ERRORs. */
@Injectable()
export class ZodInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const opts = this.reflector.get<RouteOptions | undefined>(ROUTE_META, ctx.getHandler());
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (opts?.body) req.zodBody = opts.body.parse(req.body ?? {});
    if (opts?.query) req.zodQuery = opts.query.parse(req.query);
    return next.handle();
  }
}

export const ZBody = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AppRequest>().zodBody,
);
export const ZQuery = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AppRequest>().zodQuery,
);
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest<AppRequest>().user as AuthUser,
);
/** Validated uuid path parameter; malformed ids are a coded 400, never a DB error. */
export const UuidParam = createParamDecorator((name: string, ctx: ExecutionContext): string => {
  const params = ctx.switchToHttp().getRequest<AppRequest>().params as Record<string, string>;
  const parsed = z.string().uuid().safeParse(params[name]);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', `Invalid ${name}`);
  return parsed.data;
});
/** Validated positive-integer path parameter. */
export const IntParam = createParamDecorator((name: string, ctx: ExecutionContext): number => {
  const params = ctx.switchToHttp().getRequest<AppRequest>().params as Record<string, string>;
  const parsed = z.coerce.number().int().positive().safeParse(params[name]);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', `Invalid ${name}`);
  return parsed.data;
});
export const IdemKey = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string | undefined =>
    ctx.switchToHttp().getRequest<AppRequest>().header('idempotency-key'),
);
