/**
 * Application error taxonomy. Every thrown `AppError` carries an HTTP status and
 * a stable machine-readable `code`, so the React client can react to specific
 * failures (e.g. INSUFFICIENT_STOCK) without string matching.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_EXPIRED'
  | 'FORBIDDEN'
  | 'OUT_OF_SCOPE'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INSUFFICIENT_STOCK'
  | 'IMMUTABLE_RECORD'
  | 'INVALID_STATE_TRANSITION'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const validationFailed = (message: string, details?: unknown) =>
  new AppError(422, 'VALIDATION_FAILED', message, details);

export const unauthenticated = (message = 'Authentication required.') =>
  new AppError(401, 'UNAUTHENTICATED', message);

export const invalidCredentials = (message = 'Invalid username or password.') =>
  new AppError(401, 'INVALID_CREDENTIALS', message);

export const tokenExpired = (message = 'Session expired. Please sign in again.') =>
  new AppError(401, 'TOKEN_EXPIRED', message);

export const forbidden = (message = 'Your role does not permit this operation.') =>
  new AppError(403, 'FORBIDDEN', message);

export const outOfScope = (message = 'That record belongs to a base outside your scope.') =>
  new AppError(403, 'OUT_OF_SCOPE', message);

export const notFound = (entity: string, id?: string | number) =>
  new AppError(404, 'NOT_FOUND', id === undefined ? `${entity} not found.` : `${entity} '${id}' not found.`);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details);

export const insufficientStock = (message: string, details?: unknown) =>
  new AppError(409, 'INSUFFICIENT_STOCK', message, details);

export const immutableRecord = (message = 'This record is append-only and cannot be modified.') =>
  new AppError(409, 'IMMUTABLE_RECORD', message);

export const invalidStateTransition = (message: string, details?: unknown) =>
  new AppError(409, 'INVALID_STATE_TRANSITION', message, details);
