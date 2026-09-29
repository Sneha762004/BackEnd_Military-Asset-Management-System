import { Router } from 'express';
import { z } from 'zod';
import { ACTIONS, RESOURCES, p } from '../config/rbac.js';
import { getDb, inTransaction, nowIso } from '../db/connection.js';
import { authenticate } from '../middleware/auth.js';
import { assertWithinScope, authorize, resolveTargetBaseId } from '../middleware/rbac.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { audit, recordAuditedEntity } from '../middleware/audit.js';
import { paginationSchema, validate, zId, zIsoDate, zNonNegativeQuantity, zText } from '../middleware/validate.js';
import { conflict, notFound } from '../utils/errors.js';
import { postLedgerEntry } from '../services/stockService.js';
import { offsetOf, orderBy, pageMeta, startOfCurrentMonth, today } from '../utils/query.js';
import type { AppRequest } from '../types/index.js';

export const openingBalanceRouter = Router();

openingBalanceRouter.use(authenticate);

interface OpeningBalanceRow {
  id: number;
  base_id: number;
  base_code: string;
  base_name: string;
  equipment_type_id: number;
  equipment_code: string;
  equipment_name: string;
  equipment_category: string;
  equipment_unit: string;
  period_start: string;
  quantity: number;
  notes: string;
  recorded_by_username: string | null;
  created_at: string;
}

const SELECT_OPENING = `
  SELECT ob.id, ob.base_id, b.code AS base_code, b.name AS base_name,
         ob.equipment_type_id, e.code AS equipment_code, e.name AS equipment_name,
         e.category AS equipment_category, e.unit AS equipment_unit,
         ob.period_start, ob.quantity, ob.notes, u.username AS recorded_by_username, ob.created_at
    FROM opening_balances ob
    JOIN bases b          ON b.id = ob.base_id
    JOIN equipment_types e ON e.id = ob.equipment_type_id
    LEFT JOIN users u      ON u.id = ob.recorded_by`;

/** GET /api/opening-balances */
openingBalanceRouter.get(
  '/',
  authorize(p(RESOURCES.OPENING_BALANCE, ACTIONS.READ)),
  validate(paginationSchema, 'query'),
  validate(
    z
      .object({
        periodStart: zIsoDate.optional(),
        baseId: zId.optional(),
        equipmentTypeId: zId.optional(),
      })
      .partial(),
    'query',
  ),
  asyncHandler((req, res) => {
    const { page, pageSize, sort, order } = req.query as unknown as z.infer<typeof paginationSchema>;
    const appReq = req as AppRequest;

    const scopeBaseId = appReq.user!.role === 'ADMIN' ? null : appReq.user!.baseId;
    const periodStart =
      typeof req.query.periodStart === 'string' ? req.query.periodStart : startOfCurrentMonth();
    const baseId =
      scopeBaseId ??
      (typeof req.query.baseId === 'string' ? Number(req.query.baseId) : null);
    const equipmentTypeId =
      typeof req.query.equipmentTypeId === 'string' ? Number(req.query.equipmentTypeId) : null;

    const where = `
      ob.period_start = @periodStart
      AND (@baseId IS NULL OR ob.base_id = @baseId)
      AND (@equipmentTypeId IS NULL OR ob.equipment_type_id = @equipmentTypeId)`;
    const params = { periodStart, baseId, equipmentTypeId };
    const db = getDb();

    const total = (db.prepare(`SELECT COUNT(*) AS n FROM opening_balances ob WHERE ${where}`).get(params) as { n: number })
      .n;

    const items = db
      .prepare(
        `${SELECT_OPENING} WHERE ${where}
         ORDER BY ${orderBy({ sort, order }, 'ob.base_id')}
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: pageSize, offset: offsetOf(page, pageSize) }) as OpeningBalanceRow[];

    res.json({ data: items, meta: { ...pageMeta(total, page, pageSize), periodStart } });
  }),
);

const openingBalanceSchema = z.object({
  baseId: zId,
  equipmentTypeId: zId,
  /** Always normalised to the 1st of the month by the schema. */
  periodStart: zIsoDate.optional(),
  quantity: zNonNegativeQuantity,
  notes: zText,
});

/**
 * POST /api/opening-balances - declare the stock position at a period start.
 *
 * This is a deliberate, signed-off statement rather than a computed figure, and
 * it posts an OPENING_BALANCE ledger line so every later closing balance can be
 * reconciled back to it. One record per (base, equipment type, period) - the
 * UNIQUE key makes a second declaration a 409 rather than a silent overwrite.
 */
openingBalanceRouter.post(
  '/',
  audit('OPENING_BALANCE_CREATE', 'openingBalance'),
  authorize(p(RESOURCES.OPENING_BALANCE, ACTIONS.CREATE)),
  validate(openingBalanceSchema),
  asyncHandler((req, res) => {
    const body = req.body as z.infer<typeof openingBalanceSchema>;
    const user = (req as AppRequest).user!;
    const appReq = req as AppRequest;
    const baseId = resolveTargetBaseId(appReq, body.baseId);
    const periodStart = body.periodStart ?? startOfCurrentMonth();
    const normalised = `${periodStart.slice(0, 7)}-01`;
    const db = getDb();

    if (!db.prepare('SELECT id FROM equipment_types WHERE id = ? AND is_active = 1').get(body.equipmentTypeId)) {
      throw notFound('Equipment type', body.equipmentTypeId);
    }

    const existing = db
      .prepare(
        `SELECT id FROM opening_balances
          WHERE base_id = ? AND equipment_type_id = ? AND period_start = ?`,
      )
      .get(baseId, body.equipmentTypeId, normalised);
    if (existing) {
      throw conflict(
        `An opening balance for this base, equipment type and period (${normalised}) has already been recorded.`,
      );
    }

    const result = inTransaction((tx) => {
      const reference = `OB-${normalised.slice(0, 4)}-${String(baseId).padStart(3, '0')}-${String(body.equipmentTypeId).padStart(4, '0')}`;

      const info = tx
        .prepare(
          `INSERT INTO opening_balances
             (base_id, equipment_type_id, period_start, quantity, recorded_by, notes)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(baseId, body.equipmentTypeId, normalised, body.quantity, user.id, body.notes);
      const id = Number(info.lastInsertRowid);

      if (body.quantity > 0) {
        postLedgerEntry(tx, {
          baseId,
          equipmentTypeId: body.equipmentTypeId,
          txnType: 'OPENING_BALANCE',
          refType: 'OPENING_BALANCE',
          refId: id,
          refReference: reference,
          quantity: body.quantity,
          deltaOnHand: body.quantity,
          effectiveDate: normalised,
          note: body.notes || `Opening position for ${normalised.slice(0, 7)}`,
          actorId: user.id,
          requestId: appReq.ctx?.requestId ?? null,
        });
      }

      return { id, reference };
    });

    recordAuditedEntity(req, result.id, { baseId, periodStart: normalised, quantity: body.quantity });
    res.status(201).json({ data: { id: result.id, periodStart: normalised } });
  }),
);

/**
 * GET /api/opening-balances/next-period
 *
 * Convenience for the UI: the first day of the month after the current period,
 * so the "record opening balances" form opens on the right date.
 */
openingBalanceRouter.get(
  '/next-period',
  authorize(p(RESOURCES.OPENING_BALANCE, ACTIONS.READ)),
  asyncHandler((_req, res) => {
    const now = new Date(`${today()}T00:00:00Z`);
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    res.json({ data: { periodStart: next.toISOString().slice(0, 10), currentPeriod: startOfCurrentMonth() } });
  }),
);

/** PATCH /api/opening-balances/:id - restate a declared position. */
openingBalanceRouter.patch(
  '/:id',
  audit('OPENING_BALANCE_UPDATE', 'openingBalance'),
  authorize(p(RESOURCES.OPENING_BALANCE, ACTIONS.UPDATE)),
  validate(z.object({ id: zId }), 'params'),
  validate(z.object({ quantity: zNonNegativeQuantity, notes: zText })),
  asyncHandler((req, res) => {
    const id = Number(req.params.id);
    const body = req.body as { quantity: number; notes: string };
    const user = (req as AppRequest).user!;
    const db = getDb();

    const before = db.prepare('SELECT * FROM opening_balances WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!before) throw notFound('Opening balance', id);
    assertWithinScope(req as AppRequest, before.base_id as number, 'Opening balance');

    const delta = body.quantity - (before.quantity as number);

    inTransaction((tx) => {
      tx.prepare('UPDATE opening_balances SET quantity = ?, notes = ? WHERE id = ?').run(
        body.quantity,
        body.notes,
        id,
      );

      if (delta !== 0) {
        // Restating the opening position is posted as a signed ADJUSTMENT so the
        // ledger still reconciles; it is not a silent in-place edit.
        postLedgerEntry(tx, {
          baseId: before.base_id as number,
          equipmentTypeId: before.equipment_type_id as number,
          txnType: 'ADJUSTMENT',
          refType: 'OPENING_BALANCE',
          refId: id,
          refReference: `OB-${(before.period_start as string).slice(0, 4)}`,
          quantity: Math.abs(delta),
          deltaOnHand: delta,
          effectiveDate: before.period_start as string,
          note: `Opening balance restated from ${before.quantity as number} to ${body.quantity}`,
          actorId: user.id,
          requestId: (req as AppRequest).ctx?.requestId ?? null,
        });
      }
    });

    recordAuditedEntity(req, id, { before, after: body });
    res.json({ data: { id, quantity: body.quantity, adjustment: delta } });
  }),
);
