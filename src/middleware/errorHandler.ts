import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { AppRequest } from '../types/index.js';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route matches ${req.method} ${req.originalUrl}`,
    },
  });
}

/**
 * Terminal error handler. Converts anything thrown in a handler into the single
 * error envelope the client understands.
 *
 * - `AppError`          -> its own status/code (expected failures).
 * - `ZodError`          -> 422 with field issues (defensive; `validate()` normally
 *                          converts these before they reach here).
 * - `SQLITE_CONSTRAINT` -> 409, with the constraint name preserved so the client
 *                          can tell a duplicate reference from a CHECK failure.
 * - anything else       -> 500, details withheld unless not in production.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const appReq = req as AppRequest;
  const requestId = appReq.ctx?.requestId;

  if (res.headersSent) {
    _next(err);
    return;
  }

  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ err, requestId }, 'Application error');
    else logger.debug({ code: err.code, requestId, path: req.originalUrl }, err.message);

    res.status(err.status).json({
      ...err.toJSON(),
      meta: { requestId },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed.',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      meta: { requestId },
    });
    return;
  }

  const sqliteCode = (err as { code?: string } | null)?.code;
  if (typeof sqliteCode === 'string' && sqliteCode.startsWith('SQLITE_CONSTRAINT')) {
    const message = (err as Error).message ?? 'Constraint violation';
    // stock_ledger immutability triggers land here too.
    if (/append-only/i.test(message)) {
      res.status(409).json({
        error: { code: 'IMMUTABLE_RECORD', message },
        meta: { requestId },
      });
      return;
    }
    logger.warn({ err, requestId, path: req.originalUrl }, 'Database constraint violation');
    res.status(409).json({
      error: {
        code: 'CONFLICT',
        message: 'The record conflicts with existing data.',
        details: config.isProduction ? undefined : message,
      },
      meta: { requestId },
    });
    return;
  }

  logger.error({ err, requestId, path: req.originalUrl }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: 'An unexpected error occurred.',
      ...(config.isProduction ? {} : { details: (err as Error)?.message ?? String(err) }),
    },
    meta: { requestId },
  });
}

/** Wrap an async handler so a rejected promise reaches `errorHandler`. */
export function asyncHandler<T extends Request = AppRequest>(
  fn: (req: T, res: Response, next: NextFunction) => unknown | Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req as T, res, next)).catch(next);
  };
}
