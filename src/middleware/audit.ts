import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/connection.js';
import { logger } from '../utils/logger.js';
import type { AppRequest } from '../types/index.js';

export type AuditOutcome = 'SUCCESS' | 'DENIED' | 'FAILURE';

/**
 * Declarative audit capture.
 *
 *   router.post('/', authenticate, audit('PURCHASE_CREATE', 'purchase'),
 *               authorize(...), handler)
 *
 * `audit` must sit **before** `authorize` in the chain. It only registers a
 * listener, so placing it first is what lets a 403 raised by `authorize` still
 * be recorded - the request never reaches the handler, but the row is written
 * on `res.finish` with the real status code. The reverse order silently loses
 * every authorization refusal, which is exactly the attempt worth noticing.
 *
 * The row is written on `res.finish` so it always reflects the real status
 * code, and nothing is written for a request that crashed before reaching the
 * audit marker.
 */
export function audit(action: string, entityType: string) {
  return function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
    const appReq = req as AppRequest;
    appReq.audit = { action, entityType };

    res.on('finish', () => {
      const user = appReq.user;
      const status = res.statusCode;
      // DENIED is a privilege decision (the caller may not do this at all);
      // FAILURE is everything else that did not go through, including a 409
      // business conflict and a 422 validation rejection. Anything 2xx/3xx is
      // SUCCESS. Only a 2xx may be called SUCCESS - recording a rejected
      // request as a success would make the field worthless.
      const outcome: AuditOutcome =
        status === 401 || status === 403 ? 'DENIED' : status >= 400 ? 'FAILURE' : 'SUCCESS';

      const details = appReq.audit;
      const entityId =
        details?.entityId ??
        (res.locals.auditEntityId as string | number | undefined) ??
        '';

      try {
        getDb()
          .prepare(
            `INSERT INTO audit_logs
               (request_id, actor_id, actor_username, actor_role, action, entity_type, entity_id,
                method, path, status_code, outcome, ip_address, user_agent,
                before_state, after_state, message, duration_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            appReq.ctx?.requestId ?? null,
            user?.id ?? null,
            user?.username ?? 'anonymous',
            user?.role ?? '',
            details?.action ?? action,
            details?.entityType ?? entityType,
            String(entityId),
            req.method,
            req.originalUrl,
            status,
            outcome,
            req.ip ?? '',
            (req.header('user-agent') ?? '').slice(0, 255),
            details?.before === undefined ? null : JSON.stringify(details.before),
            details?.after === undefined ? null : JSON.stringify(details.after),
            details?.message ?? '',
            appReq.ctx ? Date.now() - appReq.ctx.startedAt : null,
          );
      } catch (error) {
        // Auditing must never take down the request path, but a silent loss of an
        // audit record is itself a security event, so log it loudly.
        logger.error({ err: error, action, requestId: appReq.ctx?.requestId }, 'Failed to write audit log');
      }
    });

    next();
  };
}

/** Handler-side helper to attach the resulting record to the pending audit row. */
export function recordAuditedEntity(req: Request, entityId: string | number, after?: unknown): void {
  const appReq = req as AppRequest;
  if (appReq.audit) {
    appReq.audit.entityId = entityId;
    if (after !== undefined) appReq.audit.after = after;
  }
}
