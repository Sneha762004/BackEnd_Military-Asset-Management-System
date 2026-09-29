import { Router } from 'express';
import { z } from 'zod';
import { ACTIONS, RESOURCES, p } from '../config/rbac.js';
import { getDb } from '../db/connection.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/rbac.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { paginationSchema, validate, zId } from '../middleware/validate.js';
import { offsetOf, orderBy, pageMeta } from '../utils/query.js';
import type { LedgerRow } from '../services/stockService.js';
import type { AppRequest } from '../types/index.js';

export const ledgerRouter = Router();

ledgerRouter.use(authenticate);

const SELECT_LEDGER = `
  SELECT l.id, l.base_id, b.code AS base_code, b.name AS base_name,
         l.equipment_type_id, e.code AS equipment_code, e.name AS equipment_name,
         e.category AS equipment_category, e.unit AS equipment_unit,
         l.txn_type, l.ref_type, l.ref_id, l.ref_reference, l.quantity, l.direction,
         l.delta_on_hand, l.delta_committed, l.balance_on_hand, l.balance_committed,
         l.effective_date, l.note, l.actor_id, u.username AS actor_username,
         l.request_id, l.created_at
    FROM stock_ledger l
    JOIN bases b          ON b.id = l.base_id
    JOIN equipment_types e ON e.id = l.equipment_type_id
    LEFT JOIN users u      ON u.id = l.actor_id`;

const ledgerQuerySchema = z.object({
  baseId: zId.optional(),
  equipmentTypeId: zId.optional(),
  category: z.string().trim().max(30).optional(),
  txnType: z.string().trim().max(30).optional(),
  refType: z.string().trim().max(30).optional(),
  refId: zId.optional(),
  dateFrom: z.string().trim().max(10).optional(),
  dateTo: z.string().trim().max(10).optional(),
  direction: z.enum(['IN', 'OUT']).optional(),
  search: z.string().trim().max(120).optional(),
});

/**
 * GET /api/ledger - the movement history, in full.
 *
 * Read-only by design: there is no POST/PATCH/DELETE on this router, and the
 * table itself has BEFORE UPDATE / BEFORE DELETE triggers that abort. It is the
 * "clear history of movements" the requirements ask for - every row carries its
 * document reference, its author and the balance it produced, so any figure on
 * the dashboard can be traced to the movements that caused it.
 */
ledgerRouter.get(
  '/',
  authorize(p(RESOURCES.DASHBOARD, ACTIONS.READ)),
  validate(paginationSchema, 'query'),
  validate(ledgerQuerySchema, 'query'),
  asyncHandler((req, res) => {
    const { page, pageSize, sort, order } = req.query as unknown as z.infer<typeof paginationSchema>;
    const appReq = req as AppRequest;
    const q = req.query as Record<string, string | undefined>;

    // Base scoping: an ADMIN may filter by any base, anyone else is pinned to
    // their own regardless of what the query string asks for.
    const baseId = appReq.user!.role === 'ADMIN' ? (q.baseId ? Number(q.baseId) : null) : appReq.user!.baseId;

    const where = `
      (:baseId IS NULL OR l.base_id = @baseId)
      AND (:equipmentTypeId IS NULL OR l.equipment_type_id = @equipmentTypeId)
      AND (:category IS NULL OR e.category = @category)
      AND (:txnType IS NULL OR l.txn_type = @txnType)
      AND (:refType IS NULL OR l.ref_type = @refType)
      AND (:refId IS NULL OR l.ref_id = @refId)
      AND (:dateFrom IS NULL OR l.effective_date >= @dateFrom)
      AND (:dateTo IS NULL OR l.effective_date <= @dateTo)
      AND (:direction IS NULL OR l.direction = @direction)
      AND (@search IS NULL OR l.ref_reference LIKE @search OR l.note LIKE @search)`;

    const params = {
      baseId,
      equipmentTypeId: q.equipmentTypeId ? Number(q.equipmentTypeId) : null,
      category: q.category ?? null,
      txnType: q.txnType ?? null,
      refType: q.refType ?? null,
      refId: q.refId ? Number(q.refId) : null,
      dateFrom: q.dateFrom ?? null,
      dateTo: q.dateTo ?? null,
      direction: q.direction ?? null,
      search: q.search ? `%${q.search}%` : null,
    };

    const db = getDb();
    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM stock_ledger l JOIN equipment_types e ON e.id = l.equipment_type_id WHERE ${where}`,
        )
        .get(params) as { n: number }
    ).n;

    const items = db
      .prepare(
        `${SELECT_LEDGER} WHERE ${where}
         ORDER BY ${orderBy({ sort, order }, 'l.id')} LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: pageSize, offset: offsetOf(page, pageSize) }) as LedgerRow[];

    // Inbound/outbound totals for the filtered window, so the client can show
    // the net change without summing the page it happens to be looking at.
    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN l.direction = 'IN'  THEN l.quantity END), 0) AS inbound,
                COALESCE(SUM(CASE WHEN l.direction = 'OUT' THEN l.quantity END), 0) AS outbound
           FROM stock_ledger l
           JOIN equipment_types e ON e.id = l.equipment_type_id
          WHERE ${where}`,
      )
      .get(params) as { inbound: number; outbound: number };

    res.json({
      data: items,
      meta: {
        ...pageMeta(total, page, pageSize),
        summary: { ...totals, net: totals.inbound - totals.outbound },
      },
    });
  }),
);

/** GET /api/ledger/balances - current on-hand / committed per base+equipment. */
ledgerRouter.get(
  '/balances',
  authorize(p(RESOURCES.DASHBOARD, ACTIONS.READ)),
  validate(
    z.object({
      baseId: zId.optional(),
      equipmentTypeId: zId.optional(),
      category: z.string().trim().max(30).optional(),
    }),
    'query',
  ),
  asyncHandler((req, res) => {
    const appReq = req as AppRequest;
    const q = req.query as Record<string, string | undefined>;
    const baseId = appReq.user!.role === 'ADMIN' ? (q.baseId ? Number(q.baseId) : null) : appReq.user!.baseId;
    const equipmentTypeId = q.equipmentTypeId ? Number(q.equipmentTypeId) : null;

    const items = getDb()
      .prepare(
        `SELECT l.base_id, b.code AS base_code, b.name AS base_name,
                l.equipment_type_id, e.code AS equipment_code, e.name AS equipment_name,
                e.category AS equipment_category, e.unit AS equipment_unit,
                SUM(l.delta_on_hand)   AS on_hand,
                SUM(l.delta_committed) AS committed,
                SUM(l.delta_on_hand) - SUM(l.delta_committed) AS available,
                MAX(l.effective_date)  AS last_movement_date
           FROM stock_ledger l
           JOIN bases b          ON b.id = l.base_id
           JOIN equipment_types e ON e.id = l.equipment_type_id
          WHERE (@baseId IS NULL OR l.base_id = @baseId)
            AND (@equipmentTypeId IS NULL OR l.equipment_type_id = @equipmentTypeId)
            AND (@category IS NULL OR e.category = @category)
       GROUP BY l.base_id, l.equipment_type_id
       ORDER BY b.code, e.name`,
      )
      .all({ baseId, equipmentTypeId, category: q.category ?? null });

    res.json({ data: items });
  }),
);
