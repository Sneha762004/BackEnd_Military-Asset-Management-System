import type { NextFunction, Request, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { validationFailed } from '../utils/errors.js';

type Source = 'body' | 'query' | 'params';

function formatIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    code: issue.code,
    message: issue.message,
  }));
}

/**
 * Declarative request validation with a zod schema.
 *
 *   router.get('/', validate(paginationSchema, 'query'),
 *              validate(reportFilterSchema, 'query'), handler)
 *
 * Behaviour differs by source, and the difference matters:
 *
 *  - `body` is **replaced** by the parsed result. A zod object strips unknown
 *    keys, so a client cannot smuggle `base_id`, `status` or `created_by` into
 *    a body and have a controller read it.
 *  - `query` and `params` are **merged** into what is already there. Several
 *    `validate()` calls are stacked on one route (pagination, then filters);
 *    replacing would mean the last one silently discards the earlier results
 *    and the controller reads `undefined` for `pageSize`.
 *
 * A zod failure becomes a 422 with a field-level error list the UI renders inline.
 */
export function validate<T extends ZodTypeAny>(schema: T, source: Source = 'body') {
  return function validateMiddleware(req: Request, _res: Response, next: NextFunction): void {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(validationFailed('Request validation failed.', formatIssues(result.error)));
      return;
    }

    const value =
      source === 'body'
        ? result.data
        : { ...(req[source] as Record<string, unknown>), ...(result.data as Record<string, unknown>) };

    // req.query/params are getter-only on Express 5; assign via defineProperty so
    // the parsed value is what the handler sees either way.
    Object.defineProperty(req, source, { value, writable: true, configurable: true });
    next();
  };
}

/**
 * A positive integer id.
 *
 * The preprocess step matters for error quality: `z.coerce.number()` turns a
 * missing value into `NaN` and reports "Expected number, received nan", which
 * tells the user nothing. Passing the value through untouched when it is absent
 * lets zod report a proper "Required".
 */
export const zId = z.preprocess(
  (value) => (value === undefined || value === null || value === '' ? undefined : value),
  z.coerce.number().int().positive('Expected a positive whole number'),
);

export const zOptionalId = zId.nullish().transform((value) => value ?? null);
export const zIsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD)')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Not a real calendar date');
export const zIsoDateTime = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));
export const zQuantity = z.coerce.number().int().positive('Quantity must be a whole number greater than zero');
export const zNonNegativeQuantity = z.coerce.number().int().min(0);
export const zMoney = z.coerce.number().int().min(0, 'Amount cannot be negative');
export const zShortText = z.string().trim().min(1).max(255);
export const zText = z.string().trim().max(2000).default('');

/** Turns a zod schema into a Express query parser for `?page=&pageSize=`. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().trim().max(50).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type Pagination = z.infer<typeof paginationSchema>;
