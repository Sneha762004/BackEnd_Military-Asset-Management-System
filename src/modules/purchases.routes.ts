import { Router } from 'express';
import { z } from 'zod';
import { ACTIONS, RESOURCES, p } from '../config/rbac.js';
import { getDb, inTransaction, nowIso } from '../db/connection.js';
import { authenticate } from '../middleware/auth.js';
import { assertWithinScope, authorize, resolveTargetBaseId } from '../middleware/rbac.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { audit, recordAuditedEntity } from '../middleware/audit.js';
import { validate, zId, zIsoDate, zMoney, zQuantity, zShortText, zText } from '../middleware/validate.js';
import { paginationSchema } from '../middleware/validate.js';
import { conflict, notFound } from '../utils/errors.js';
import { nextReference } from '../utils/reference.js';
import { postLedgerEntry } from '../services/stockService.js';
import {
  effectiveFilters,
  offsetOf,
  orderBy,
  pageMeta,
  reportFilterSchema,
  type ReportFilters,
} from '../utils/query.js';
import type { AppRequest } from '../types/index.js';

export const purchaseRouter = Router();

purchaseRouter.use(authenticate);

interface PurchaseRow {
  id: number;
  reference: string;
  base_id: number;
  base_code: string;
  base_name: string;
  equipment_type_id: number;
  equipment_code: string;
  equipment_name: string;
  equipment_category: string;
  equipment_unit: string;
  quantity: number;
  unit_cost: number;
  total_cost: number;
  supplier: string;
  contract_ref: string;
  purchase_date: string;
  received_date: string;
  status: string;
  notes: string;
  created_by_username: string;
  created_at: string;
}

const SELECT_PURCHASE = `
  SELECT pu.id, pu.reference, pu.base_id, b.code AS base_code, b.name AS base_name,
         pu.equipment_type_id, e.code AS equipment_code, e.name AS equipment_name,
         e.category AS equipment_category, e.unit AS equipment_unit,
         pu.quantity, pu.unit_cost, (pu.quantity * pu.unit_cost) AS total_cost,
         pu.supplier, pu.contract_ref, pu.purchase_date, pu.received_date,
         pu.status, pu.notes, u.username AS created_by_username, pu.created_at
    FROM purchases pu
    JOIN bases b          ON b.id = pu.base_id
    JOIN equipment_types e ON e.id = pu.equipment_type_id
    JOIN users u          ON u.id = pu.created_by`;

/**
 * GET /api/purchases - historical purchases, filterable by date range,
 * equipment type (and category) and base, per the requirements.
 */
purchaseRouter.get(
  '/',
  authorize(p(RESOURCES.PURCHASE, ACTIONS.READ)),
  validate(paginationSchema, 'query'),
  validate(reportFilterSchema.partial(), 'query'),
  asyncHandler((req, res) => {
    const filters = effectiveFilters(req as AppRequest, req.query as unknown as ReportFilters);
    const { page, pageSize, sort, order } = req.query as unknown as z.infer<typeof paginationSchema>;
    const db = getDb();

    const where: string[] = [
      'pu.received_date BETWEEN @dateFrom AND @dateTo',
      '(@baseId IS NULL OR pu.base_id = @baseId)',
      '(@equipmentTypeId IS NULL OR pu.equipment_type_id = @equipmentTypeId)',
      '(@category IS NULL OR e.category = @category)',
      '(@status IS NULL OR pu.status = @status)',
      `(@search IS NULL OR pu.reference LIKE @search OR pu.supplier LIKE @search
        OR pu.contract_ref LIKE @search OR e.name LIKE @search)`,
    ];

    const params = {
      ...filters,
      search: filters.search ? `%${filters.search}%` : null,
    };

    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM purchases pu JOIN equipment_types e ON e.id = pu.equipment_type_id WHERE ${where.join(' AND ')}`,
        )
        .get(params) as { n: number }
    ).n;

    const items = db
      .prepare(
        `${SELECT_PURCHASE} WHERE ${where.join(' AND ')}
         ORDER BY ${orderBy({ sort, order }, 'pu.received_date')}
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: pageSize, offset: offsetOf(page, pageSize) }) as PurchaseRow[];

    const summary = db
      .prepare(
        `SELECT COUNT(*) AS document_count,
                COALESCE(SUM(pu.quantity), 0) AS total_quantity,
                COALESCE(SUM(pu.quantity * pu.unit_cost), 0) AS total_value
           FROM purchases pu JOIN equipment_types e ON e.id = pu.equipment_type_id
          WHERE ${where.join(' AND ')} AND pu.status = 'RECEIVED'`,
      )
      .get(params) as { document_count: number; total_quantity: number; total_value: number };

    res.json({ data: items, meta: { ...pageMeta(total, page, pageSize), summary } });
  }),
);

/** GET /api/purchases/:id */
purchaseRouter.get(
  '/:id',
  authorize(p(RESOURCES.PURCHASE, ACTIONS.READ)),
  validate(z.object({ id: zId }), 'params'),
  asyncHandler((req, res) => {
    const row = getDb()
      .prepare(`${SELECT_PURCHASE} WHERE pu.id = ?`)
      .get(req.params.id) as PurchaseRow | undefined;
    if (!row) throw notFound('Purchase', req.params.id);
    assertWithinScope(req as AppRequest, row.base_id, `Purchase ${row.reference}`);
    res.json({ data: row });
  }),
);

const purchaseSchema = z
  .object({
    baseId: zId.nullish(),
    equipmentTypeId: zId,
    quantity: zQuantity,
    unitCost: zMoney.default(0),
    supplier: z.string().trim().max(200).default(''),
    contractRef: z.string().trim().max(100).default(''),
    purchaseDate: zIsoDate,
    receivedDate: zIsoDate,
    notes: zText,
  })
  .refine((value) => value.receivedDate >= value.purchaseDate, {
    message: 'Received date cannot precede the purchase date',
    path: ['receivedDate'],
  });

/**
 * POST /api/purchases - record goods received into a base's stock.
 *
 * Creating the document and posting its ledger line happen in one transaction,
 * so a purchase is either fully recorded (and visible in every balance) or not
 * recorded at all. There is no window where the document exists but the stock
 * does not move.
 */
purchaseRouter.post(
  '/',
  audit('PURCHASE_CREATE', 'purchase'),
  authorize(p(RESOURCES.PURCHASE, ACTIONS.CREATE)),
  validate(purchaseSchema),
  asyncHandler((req, res) => {
    const body = req.body as z.infer<typeof purchaseSchema>;
    const user = (req as AppRequest).user!;
    const baseId = resolveTargetBaseId(req as AppRequest, body.baseId ?? null);
    const db = getDb();

    const equipment = db
      .prepare('SELECT id, name FROM equipment_types WHERE id = ? AND is_active = 1')
      .get(body.equipmentTypeId) as { id: number; name: string } | undefined;
    if (!equipment) throw notFound('Equipment type', body.equipmentTypeId);

    const result = inTransaction((tx) => {
      const reference = nextReference(tx, 'PURCHASE', body.receivedDate);
      const info = tx
        .prepare(
          `INSERT INTO purchases
             (reference, base_id, equipment_type_id, quantity, unit_cost, supplier, contract_ref,
              purchase_date, received_date, status, notes, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?, ?, ?)`,
        )
        .run(
          reference,
          baseId,
          body.equipmentTypeId,
          body.quantity,
          body.unitCost,
          body.supplier,
          body.contractRef,
          body.purchaseDate,
          body.receivedDate,
          body.notes,
          user.id,
          nowIso(),
          nowIso(),
        );
      const id = Number(info.lastInsertRowid);

      postLedgerEntry(tx, {
        baseId,
        equipmentTypeId: body.equipmentTypeId,
        txnType: 'PURCHASE',
        refType: 'PURCHASE',
        refId: id,
        refReference: reference,
        quantity: body.quantity,
        deltaOnHand: body.quantity,
        effectiveDate: body.receivedDate,
        note: `Goods received from ${body.supplier || 'supplier not recorded'}`,
        actorId: user.id,
        requestId: (req as AppRequest).ctx?.requestId ?? null,
      });

      return { id, reference };
    });

    recordAuditedEntity(req, result.id, {
      reference: result.reference,
      baseId,
      equipmentTypeId: body.equipmentTypeId,
      quantity: body.quantity,
      unitCost: body.unitCost,
      supplier: body.supplier,
    });

    res.status(201).json({ data: { id: result.id, reference: result.reference } });
  }),
);

const purchaseUpdateSchema = z.object({
  supplier: z.string().trim().max(200).optional(),
  contractRef: z.string().trim().max(100).optional(),
  unitCost: zMoney.optional(),
  notes: zText.optional(),
});

/**
 * PATCH /api/purchases/:id - amend descriptive fields only.
 *
 * Quantity, equipment type, base and dates are deliberately immutable: changing
 * them would invalidate the ledger line that recorded the movement. To correct
 * a quantity, cancel the document and raise a replacement.
 */
purchaseRouter.patch(
  '/:id',
  audit('PURCHASE_UPDATE', 'purchase'),
  authorize(p(RESOURCES.PURCHASE, ACTIONS.UPDATE)),
  validate(z.object({ id: zId }), 'params'),
  validate(purchaseUpdateSchema),
  asyncHandler((req, res) => {
    const id = Number(req.params.id);
    const body = req.body as z.infer<typeof purchaseUpdateSchema>;
    const user = (req as AppRequest).user!;
    const db = getDb();

    const before = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!before) throw notFound('Purchase', id);
    assertWithinScope(req as AppRequest, before.base_id as number, `Purchase ${before.reference as string}`);

    if (before.status === 'CANCELLED') throw conflict('A cancelled purchase cannot be amended.');

    db.prepare(
      `UPDATE purchases
          SET supplier = @supplier, contract_ref = @contractRef, unit_cost = @unitCost,
              notes = @notes, updated_at = @updatedAt
        WHERE id = @id`,
    ).run({
      id,
      supplier: body.supplier ?? (before.supplier as string),
      contractRef: body.contractRef ?? (before.contract_ref as string),
      unitCost: body.unitCost ?? (before.unit_cost as number),
      notes: body.notes ?? (before.notes as string),
      updatedAt: nowIso(),
    });

    recordAuditedEntity(req, id, { before, after: body });
    res.json({ data: { id, updated: true } });
  }),
);

/**
 * POST /api/purchases/:id/cancel - reversing document.
 *
 * The ledger gains an ADJUSTMENT line that negates the original receipt, so the
 * movement history shows both the receipt and its reversal instead of vanishing.
 */
purchaseRouter.post(
  '/:id/cancel',
  audit('PURCHASE_CANCEL', 'purchase'),
  authorize(p(RESOURCES.PURCHASE, ACTIONS.UPDATE)),
  validate(z.object({ reason: zShortText.max(300) })),
  asyncHandler((req, res) => {
    const id = Number(req.params.id);
    const { reason } = req.body as { reason: string };
    const user = (req as AppRequest).user!;
    const db = getDb();

    const before = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!before) throw notFound('Purchase', id);
    assertWithinScope(req as AppRequest, before.base_id as number, `Purchase ${before.reference as string}`);
    if (before.status === 'CANCELLED') throw conflict('This purchase is already cancelled.');

    const reference = before.reference as string;

    inTransaction((tx) => {
      tx.prepare(
        `UPDATE purchases SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?, updated_at = ? WHERE id = ?`,
      ).run(user.id, nowIso(), nowIso(), id);

      postLedgerEntry(tx, {
        baseId: before.base_id as number,
        equipmentTypeId: before.equipment_type_id as number,
        txnType: 'ADJUSTMENT',
        refType: 'PURCHASE',
        refId: id,
        refReference: reference,
        quantity: before.quantity as number,
        deltaOnHand: -(before.quantity as number),
        effectiveDate: new Date().toISOString().slice(0, 10),
        note: `Reversal of ${reference}: ${reason}`,
        actorId: user.id,
        requestId: (req as AppRequest).ctx?.requestId ?? null,
      });
    });

    recordAuditedEntity(req, id, { before, after: { status: 'CANCELLED', reason } });
    res.json({ data: { id, status: 'CANCELLED' } });
  }),
);
