import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AppRequest } from '../types/index.js';

/**
 * Assigns a correlation id to every request and makes it visible to the client
 * (`X-Request-Id`). The same id is used by the structured HTTP log, the audit
 * table and the stock ledger, so a single string reconstructs a transaction.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();

  const appReq = req as AppRequest;
  appReq.ctx = { requestId, startedAt: Date.now() };
  res.setHeader('X-Request-Id', requestId);

  next();
}
