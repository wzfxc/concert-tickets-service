import type { ErrorCode } from '@tickets/shared';

/** Domain error carrying a coded reason; the api maps it to the single HTTP error envelope. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details?: Record<string, unknown>,
    readonly statusOverride?: number,
  ) {
    super(message ?? code);
  }
}
