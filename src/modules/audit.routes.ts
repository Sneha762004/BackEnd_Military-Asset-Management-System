import { Router } from 'express';
import { z } from 'zod';
import { ACTIONS, RESOURCES, p } from '../config/rbac.js';
import { getDb } from '../db/connection.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/rbac.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { paginationSchema, validate, zId } from '../middleware/validate.js';
import { offsetOf, orderBy, pageMeta } from '../utils/query.js';
import type { AppRequest } from '../types/index.js';

export const auditRouter = Router();

auditRouter.use(authenticate, authorize(p(RESOURCES.AUDIT, ACTIONS.READ)));

interface AuditRow {
  id: number;
  request_id: string;
  actor_id: number | null;
  actor_username: string;
  actor_role: string;
  action: string;
  entity_type: string;
  entity_id: string;
  method: string;
  path: string;
  status_code: number;
  outcome: string;
  ip_address: string;
  user_agent: string;
  message: string;
  duration_ms: number | null;
  created_at: string;
}

const auditQuerySchema = z.object({
  actorId: zId.optional(),
  actor: z.string().trim().max(60).optional(),
  action: z.string().trim().max(40).optional(),
  entityType: z.string().trim().max(40).optional(),
  outcome: z.enum(['SUCCESS', 'DENIED', 'FAILURE']).optional(),
  statusCode: z.coerce.number().int().min(100).max(599).optional(),
  dateFrom: z.string().trim().max(10).optional(),
  dateTo: z.string().trim().max(10).optional(),
  search: z.string().trim().max(120).optional(),
});

/**
 * GET /api/audit-logs - the transaction audit trail.
 *
 * Admin-only (gated at the router). Records every login, every failed
 * authorisation attempt, and every create/amend/reverse on an asset document,
 * with the before/after JSON snapshot of what changed.
 */
auditRouter.get(
  '/',
  validate(paginationSchema, 'query'),
  validate(auditQuerySchema, 'query'),
  asyncHandler((req, res) => {
    const { page, pageSize, sort, order } = req.query as unknown as z.infer<typeof paginationSchema>;
    const q = req.query as Record<string, string | undefined>;

    const where = `
      (@actorId IS NULL OR al.actor_id = @actorId)
      AND (@actor IS NULL OR al.actor_username LIKE @actor)
      AND (@action IS NULL OR al.action = @action)
      AND (@entityType IS NULL OR al.entity_type = @entityType)
      AND (@outcome IS NULL OR al.outcome = @outcome)
      AND (@statusCode IS NULL OR al.status_code = @statusCode)
      AND (@dateFrom IS NULL OR al.created_at >= @dateFrom)
      AND (@dateTo IS NULL OR al.created_at <= @dateTo)
      AND (@search IS NULL OR al.actor_username LIKE @search OR al.path LIKE @search
           OR al.message LIKE @search OR al.request_id LIKE @search)`;

    const params = {
      actorId: q.actorId ? Number(q.actorId) : null,
      actor: q.actor ? `%${q.actor}%` : null,
      action: q.action ?? null,
      entityType: q.entityType ?? null,
      outcome: q.outcome ?? null,
      statusCode: q.statusCode ? Number(q.statusCode) : null,
      dateFrom: q.dateFrom ? `${q.dateFrom}T00:00:00.000Z` : null,
      dateTo: q.dateTo ? `${q.dateTo}T23:59:59.999Z` : null,
      search: q.search ? `%${q.search}%` : null,
    };

    const db = getDb();
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_logs al WHERE ${where}`).get(params) as { n: number })
      .n;

    const items = db
      .prepare(
        `SELECT al.id, al.request_id, al.actor_id, al.actor_username, al.actor_role,
                al.action, al.entity_type, al.entity_id, al.method, al.path,
                al.status_code, al.outcome, al.ip_address, al.user_agent,
                al.message, al.duration_ms, al.created_at
           FROM audit_logs al
          WHERE ${where}
       ORDER BY ${orderBy({ sort, order }, 'al.id')}
          LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: pageSize, offset: offsetOf(page, pageSize) }) as AuditRow[];

    const actions = db
      .prepare('SELECT action AS value, COUNT(*) AS count FROM audit_logs GROUP BY action ORDER BY count DESC')
      .all() as { value: string; count: number }[];

    res.json({ data: items, meta: { ...pageMeta(total, page, pageSize), actions } });
  }),
);

/** GET /api/audit-logs/summary - activity counts by day, for the audit page chart. */
auditRouter.get(
  '/summary',
  asyncHandler((req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, outcome, COUNT(*) AS events
           FROM audit_logs
          WHERE created_at >= date('now', '-30 days')
       GROUP BY day, outcome
       ORDER BY day`,
      )
      .all() as { day: string; outcome: string; events: number }[];

    res.json({ data: rows, meta: { window: '30d', requestedBy: (req as AppRequest).user?.username } });
  }),
);

/** GET /api/audit-logs/:requestId - every API call and ledger posting in one transaction. */
auditRouter.get(
  '/:requestId',
  validate(z.object({ requestId: z.string().trim().min(8).max(64) }), 'params'),
  asyncHandler((req, res) => {
    const db = getDb();
    const { requestId } = req.params as { requestId: string };

    const logs = db
      .prepare(
        `SELECT id, request_id, actor_username, actor_role, action, entity_type, entity_id,
                method, path, status_code, outcome, message, duration_ms, created_at
           FROM audit_logs WHERE request_id = ? ORDER BY id`,
      )
      .all(requestId);

    const ledger = db
      .prepare(
        `SELECT l.id, l.txn_type, l.ref_reference, l.quantity, l.delta_on_hand, l.delta_committed,
                l.balance_on_hand, l.effective_date, b.code AS base_code, e.code AS equipment_code
           FROM stock_ledger l
           JOIN bases b ON b.id = l.base_id
           JOIN equipment_types e ON e.id = l.equipment_type_id
          WHERE l.request_id = ? ORDER BY l.id`,
      )
      .all(requestId);

    res.json({ data: { requestId, audit: logs, ledger } });
  }),
);
