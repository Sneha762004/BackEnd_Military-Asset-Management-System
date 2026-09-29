import { Router } from 'express';
import { z } from 'zod';
import { ACTIONS, RESOURCES, p } from '../config/rbac.js';
import { getDb, inTransaction, nowIso } from '../db/connection.js';
import { authenticate } from '../middleware/auth.js';
import { assertWithinScope, authorize, resolveTargetBaseId } from '../middleware/rbac.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { audit, recordAuditedEntity } from '../middleware/audit.js';
import {
  paginationSchema,
  validate,
  zId,
  zIsoDate,
  zQuantity,
  zShortText,
  zText,
} from '../middleware/validate.js';
import { conflict, forbidden, invalidStateTransition, notFound } from '../utils/errors.js';
import { nextReference } from '../utils/reference.js';
import { assertTransferableStock, postLedgerEntry } from '../services/stockService.js';
import {
  effectiveFilters,
  offsetOf,
  orderBy,
  pageMeta,
  reportFilterSchema,
  type ReportFilters,
} from '../utils/query.js';
import type { AppRequest } from '../types/index.js';

export const transferRouter = Router();

transferRouter.use(authenticate);

interface TransferRow {
  id: number;
  reference: string;
  from_base_id: number;
  from_base_code: string;
  from_base_name: string;
  to_base_id: number;
  to_base_code: string;
  to_base_name: string;
  status: string;
  transfer_date: string;
  received_date: string | null;
  vehicle_ref: string;
  notes: string;
  created_by_username: string;
  created_at: string;
  updated_at: string;
  line_count: number;
  total_quantity: number;
}

interface TransferItemRow {
  id: number;
  transfer_id: number;
  equipment_type_id: number;
  equipment_code: string;
  equipment_name: string;
  equipment_category: string;
  equipment_unit: string;
  quantity: number;
  quantity_received: number | null;
}

const SELECT_TRANSFER = `
  SELECT t.id, t.reference,
         t.from_base_id, fb.code AS from_base_code, fb.name AS from_base_name,
         t.to_base_id,   tb.code AS to_base_code,   tb.name AS to_base_name,
         t.status, t.transfer_date, t.received_date, t.vehicle_ref, t.notes,
         u.username AS created_by_username, t.created_at, t.updated_at,
         (SELECT COUNT(*) FROM transfer_items ti WHERE ti.transfer_id = t.id) AS line_count,
         (SELECT COALESCE(SUM(ti.quantity), 0) FROM transfer_items ti WHERE ti.transfer_id = t.id) AS total_quantity
    FROM transfers t
    JOIN bases fb ON fb.id = t.from_base_id
    JOIN bases tb ON tb.id = t.to_base_id
    JOIN users u  ON u.id  = t.created_by`;

/**
 * GET /api/transfers - movement history with timestamps and asset details.
 *
 * A base-scoped role sees transfers where its base is *either* end, because a
 * commander needs to see stock arriving as well as stock leaving.
 */
transferRouter.get(
  '/',
  authorize(p(RESOURCES.TRANSFER, ACTIONS.READ)),
  validate(paginationSchema, 'query'),
  validate(reportFilterSchema.partial(), 'query'),
  asyncHandler((req, res) => {
    const filters = effectiveFilters(req as AppRequest, req.query as unknown as ReportFilters);
    const { page, pageSize, sort, order } = req.query as unknown as z.infer<typeof paginationSchema>;
    const db = getDb();

    const where: string[] = [
      't.transfer_date BETWEEN @dateFrom AND @dateTo',
      '(@baseId IS NULL OR t.from_base_id = @baseId OR t.to_base_id = @baseId)',
      `(@equipmentTypeId IS NULL OR EXISTS (
          SELECT 1 FROM transfer_items ti
           WHERE ti.transfer_id = t.id AND ti.equipment_type_id = @equipmentTypeId))`,
      `(@category IS NULL OR EXISTS (
          SELECT 1 FROM transfer_items ti
            JOIN equipment_types et ON et.id = ti.equipment_type_id
           WHERE ti.transfer_id = t.id AND et.category = @category))`,
      '(@status IS NULL OR t.status = @status)',
      `(@search IS NULL OR t.reference LIKE @search OR t.vehicle_ref LIKE @search
        OR t.notes LIKE @search)`,
    ];

    const params = { ...filters, search: filters.search ? `%${filters.search}%` : null };

    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM transfers t
            WHERE ${where.join(' AND ')}`,
        )
        .get(params) as { n: number }
    ).n;

    const items = db
      .prepare(
        `${SELECT_TRANSFER} WHERE ${where.join(' AND ')}
         ORDER BY ${orderBy({ sort, order }, 't.transfer_date')}
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: pageSize, offset: offsetOf(page, pageSize) }) as TransferRow[];

    const summary = db
      .prepare(
        `SELECT
            COALESCE(SUM(CASE WHEN t.status = 'IN_TRANSIT'  THEN 1 END), 0) AS in_transit,
            COALESCE(SUM(CASE WHEN t.status = 'COMPLETED'   THEN 1 END), 0) AS completed,
            COALESCE(SUM(CASE WHEN t.status = 'DRAFT'       THEN 1 END), 0) AS drafts,
            COALESCE(SUM(CASE WHEN t.status = 'IN_TRANSIT'  THEN
              (SELECT COALESCE(SUM(ti.quantity), 0) FROM transfer_items ti WHERE ti.transfer_id = t.id)
            END), 0) AS units_in_transit
           FROM transfers t WHERE ${where.join(' AND ')}`,
      )
      .get(params) as { in_transit: number; completed: number; drafts: number; units_in_transit: number };

    res.json({ data: items, meta: { ...pageMeta(total, page, pageSize), summary } });
  }),
);

function loadItems(db: ReturnType<typeof getDb>, transferId: number): TransferItemRow[] {
  return db
    .prepare(
      `SELECT ti.id, ti.transfer_id, ti.equipment_type_id,
              e.code AS equipment_code, e.name AS equipment_name,
              e.category AS equipment_category, e.unit AS equipment_unit,
              ti.quantity, ti.quantity_received
         FROM transfer_items ti
         JOIN equipment_types e ON e.id = ti.equipment_type_id
        WHERE ti.transfer_id = ?
        ORDER BY e.name`,
    )
    .all(transferId) as TransferItemRow[];
}

/** GET /api/transfers/:id - header plus the asset lines it carries. */
transferRouter.get(
  '/:id',
  authorize(p(RESOURCES.TRANSFER, ACTIONS.READ)),
  validate(z.object({ id: zId }), 'params'),
  asyncHandler((req, res) => {
    const db = getDb();
    const transfer = db.prepare(`${SELECT_TRANSFER} WHERE t.id = ?`).get(req.params.id) as
      | TransferRow
      | undefined;
    if (!transfer) throw notFound('Transfer', req.params.id);

    const appReq = req as AppRequest;
    const visible =
      appReq.user?.role === 'ADMIN' ||
      appReq.user?.baseId === null ||
      appReq.user?.baseId === transfer.from_base_id ||
      appReq.user?.baseId === transfer.to_base_id;
    if (!visible) {
      assertWithinScope(appReq, transfer.from_base_id, `Transfer ${transfer.reference}`);
    }

    res.json({ data: { ...transfer, items: loadItems(db, transfer.id) } });
  }),
);

const transferItemSchema = z.object({
  equipmentTypeId: zId,
  quantity: zQuantity,
});

const transferSchema = z.object({
  /**
   * Optional on purpose. A base-scoped role only ever transfers out of its own
   * base, so `resolveTargetBaseId` fills it in from the token and the client
   * never has to know its base id. An Admin must supply one.
   */
  fromBaseId: zId.nullish(),
  toBaseId: zId,
  transferDate: zIsoDate,
  vehicleRef: z.string().trim().max(100).default(''),
  notes: zText,
  items: z.array(transferItemSchema).min(1, 'A transfer must carry at least one asset line'),
});

/**
 * POST /api/transfers - raise a movement instruction.
 *
 * Stock leaves the source base *at dispatch* (TRANSFER_OUT) and arrives at the
 * destination *on receipt* (TRANSFER_IN). This is deliberate: while a load is on
 * the road it is physically nobody's, and reporting it as still sitting at the
 * source would overstate the source base's holdings and understate
 * availability. The ledger shows both legs with the same reference number, which
 * is what makes the movement history legible.
 *
 * A transfer can only be raised from the caller's own base. Moving stock *out of*
 * another installation is a Base Commander's decision, not a logistics officer's
 * at the receiving end.
 */
transferRouter.post(
  '/',
  audit('TRANSFER_CREATE', 'transfer'),
  authorize(p(RESOURCES.TRANSFER, ACTIONS.CREATE)),
  validate(transferSchema),
  asyncHandler((req, res) => {
    const body = req.body as z.infer<typeof transferSchema>;
    const user = (req as AppRequest).user!;
    const appReq = req as AppRequest;

    const fromBaseId = resolveTargetBaseId(appReq, body.fromBaseId ?? null);
    const { toBaseId } = body;

    if (fromBaseId === toBaseId) {
      throw conflict('A base cannot transfer assets to itself.');
    }

    const db = getDb();
    if (!db.prepare('SELECT id FROM bases WHERE id = ? AND is_active = 1').get(toBaseId)) {
      throw notFound('Destination base', toBaseId);
    }

    // Collapse duplicate equipment lines so the (transfer, equipment) UNIQUE key
    // cannot be violated and the ledger cannot post the same type twice.
    const merged = new Map<number, number>();
    for (const item of body.items) {
      merged.set(item.equipmentTypeId, (merged.get(item.equipmentTypeId) ?? 0) + item.quantity);
    }

    const result = inTransaction((tx) => {
      // Availability is checked inside the write transaction, immediately before
      // the posting, so a concurrent transfer cannot oversubscribe the source.
      for (const [equipmentTypeId, quantity] of merged) {
        const exists = tx
          .prepare('SELECT id FROM equipment_types WHERE id = ? AND is_active = 1')
          .get(equipmentTypeId);
        if (!exists) throw notFound('Equipment type', equipmentTypeId);
        assertTransferableStock(tx, fromBaseId, equipmentTypeId, quantity, 'transfer out');
      }

      const reference = nextReference(tx, 'TRANSFER', body.transferDate);
      const info = tx
        .prepare(
          `INSERT INTO transfers
             (reference, from_base_id, to_base_id, status, transfer_date, dispatched_by,
              vehicle_ref, notes, created_by, created_at, updated_at)
           VALUES (?, ?, ?, 'IN_TRANSIT', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          reference,
          fromBaseId,
          toBaseId,
          body.transferDate,
          user.id,
          body.vehicleRef,
          body.notes,
          user.id,
          nowIso(),
          nowIso(),
        );
      const transferId = Number(info.lastInsertRowid);

      for (const [equipmentTypeId, quantity] of merged) {
        tx.prepare(
          `INSERT INTO transfer_items (transfer_id, equipment_type_id, quantity) VALUES (?, ?, ?)`,
        ).run(transferId, equipmentTypeId, quantity);

        postLedgerEntry(tx, {
          baseId: fromBaseId,
          equipmentTypeId,
          txnType: 'TRANSFER_OUT',
          refType: 'TRANSFER',
          refId: transferId,
          refReference: reference,
          quantity,
          deltaOnHand: -quantity,
          effectiveDate: body.transferDate,
          note: `Dispatched to base ${toBaseId}`,
          actorId: user.id,
          requestId: appReq.ctx?.requestId ?? null,
        });
      }

      return { id: transferId, reference };
    });

    recordAuditedEntity(req, result.id, {
      reference: result.reference,
      fromBaseId,
      toBaseId,
      lines: [...merged.entries()].map(([equipmentTypeId, quantity]) => ({ equipmentTypeId, quantity })),
    });

    // Return the full document, not a three-field stub. The UI types this
    // response as a complete `Transfer` and immediately reads `to_base_code`
    // for its success toast, so a stub renders "in transit to undefined".
    // Re-reading the row we just wrote also guarantees the create response and
    // the subsequent GET can never drift apart in shape.
    const created = db.prepare(`${SELECT_TRANSFER} WHERE t.id = ?`).get(result.id) as TransferRow | undefined;
    res.status(201).json({ data: { ...created, items: loadItems(db, result.id) } });
  }),
);

const receiveSchema = z.object({
  receivedDate: zIsoDate,
  /** Partial receipt is allowed: omit to confirm every line in full. */
  lines: z.array(z.object({ transferItemId: zId, quantityReceived: z.coerce.number().int().min(0) })).optional(),
  notes: zText,
});

/**
 * POST /api/transfers/:id/receive - confirm arrival at the destination.
 *
 * Only the receiving base (or an Admin) can confirm receipt; the Logistics
 * Officer who raised the movement at the far end cannot. This is the two-man
 * rule that stops a single account from moving stock and also confirming it.
 */
transferRouter.post(
  '/:id/receive',
  audit('TRANSFER_RECEIVE', 'transfer'),
  authorize(p(RESOURCES.TRANSFER, ACTIONS.UPDATE)),
  validate(z.object({ id: zId }), 'params'),
  validate(receiveSchema),
  asyncHandler((req, res) => {
    const id = Number(req.params.id);
    const body = req.body as z.infer<typeof receiveSchema>;
    const user = (req as AppRequest).user!;
    const appReq = req as AppRequest;
    const db = getDb();

    const transfer = db.prepare('SELECT * FROM transfers WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!transfer) throw notFound('Transfer', id);

    if (user.role !== 'ADMIN' && user.baseId !== transfer.to_base_id) {
      throw forbidden('Only the receiving base (or an Administrator) can confirm arrival of a transfer.');
    }
    if (transfer.status !== 'IN_TRANSIT') {
      throw invalidStateTransition(
        `Transfer ${transfer.reference as string} is '${transfer.status as string}' and cannot be received.`,
      );
    }

    const items = loadItems(db, id);
    const byId = new Map(items.map((item) => [item.id, item]));

    const receipts = new Map<number, number>();
    if (body.lines?.length) {
      for (const line of body.lines) {
        if (!byId.has(line.transferItemId)) {
          throw conflict(`Line ${line.transferItemId} does not belong to transfer ${transfer.reference as string}.`);
        }
        receipts.set(line.transferItemId, line.quantityReceived);
      }
    } else {
      for (const item of items) receipts.set(item.id, item.quantity);
    }

    for (const [lineId, quantity] of receipts) {
      const item = byId.get(lineId)!;
      if (quantity > item.quantity) {
        throw conflict(`Cannot receive ${quantity} of ${item.equipment_code}; only ${item.quantity} were dispatched.`);
      }
    }

    inTransaction((tx) => {
      for (const [lineId, quantity] of receipts) {
        const item = byId.get(lineId)!;
        tx.prepare('UPDATE transfer_items SET quantity_received = ? WHERE id = ?').run(quantity, lineId);

        if (quantity > 0) {
          postLedgerEntry(tx, {
            baseId: transfer.to_base_id as number,
            equipmentTypeId: item.equipment_type_id,
            txnType: 'TRANSFER_IN',
            refType: 'TRANSFER',
            refId: id,
            refReference: transfer.reference as string,
            quantity,
            deltaOnHand: quantity,
            effectiveDate: body.receivedDate,
            note: `Received from base ${transfer.from_base_id as number}`,
            actorId: user.id,
            requestId: appReq.ctx?.requestId ?? null,
          });
        }
      }

      const receivedTotal = [...receipts.values()].reduce((sum, value) => sum + value, 0);
      const orderedTotal = items.reduce((sum, item) => sum + item.quantity, 0);
      const status = receivedTotal >= orderedTotal ? 'COMPLETED' : 'IN_TRANSIT';

      tx.prepare(
        `UPDATE transfers
            SET status = @status, received_date = @receivedDate, received_by = @receivedBy,
                notes = CASE WHEN @extraNotes = '' THEN notes ELSE notes || ' | ' || @extraNotes END,
                updated_at = @updatedAt
          WHERE id = @id`,
      ).run({
        id,
        status,
        receivedDate: body.receivedDate,
        receivedBy: user.id,
        extraNotes: body.notes,
        updatedAt: nowIso(),
      });
    });

    recordAuditedEntity(req, id, { status: 'COMPLETED', receipts: [...receipts.entries()] });
    res.json({ data: { id, status: 'COMPLETED' } });
  }),
);

/**
 * POST /api/transfers/:id/cancel - reverse an in-flight movement.
 *
 * Returns the dispatched stock to the source base. Only possible while the
 * transfer is still in transit; once it is received it must be dealt with by
 * reversing the receipt instead, so the two legs can never both be erased.
 */
transferRouter.post(
  '/:id/cancel',
  audit('TRANSFER_CANCEL', 'transfer'),
  authorize(p(RESOURCES.TRANSFER, ACTIONS.UPDATE)),
  validate(z.object({ reason: zShortText.max(300) })),
  asyncHandler((req, res) => {
    const id = Number(req.params.id);
    const { reason } = req.body as { reason: string };
    const user = (req as AppRequest).user!;
    const appReq = req as AppRequest;
    const db = getDb();

    const transfer = db.prepare('SELECT * FROM transfers WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!transfer) throw notFound('Transfer', id);
    assertWithinScope(appReq, transfer.from_base_id as number, `Transfer ${transfer.reference as string}`);

    if (transfer.status !== 'IN_TRANSIT') {
      throw invalidStateTransition(
        `Only an in-transit transfer can be cancelled; ${transfer.reference as string} is '${transfer.status as string}'.`,
      );
    }

    inTransaction((tx) => {
      const items = loadItems(tx, id);
      for (const item of items) {
        postLedgerEntry(tx, {
          baseId: transfer.from_base_id as number,
          equipmentTypeId: item.equipment_type_id,
          txnType: 'ADJUSTMENT',
          refType: 'TRANSFER',
          refId: id,
          refReference: transfer.reference as string,
          quantity: item.quantity,
          deltaOnHand: item.quantity,
          effectiveDate: new Date().toISOString().slice(0, 10),
          note: `Reversal of ${transfer.reference as string}: ${reason}`,
          actorId: user.id,
          requestId: appReq.ctx?.requestId ?? null,
        });
      }

      tx.prepare(
        `UPDATE transfers SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?, updated_at = ? WHERE id = ?`,
      ).run(user.id, nowIso(), nowIso(), id);
    });

    recordAuditedEntity(req, id, { status: 'CANCELLED', reason });
    res.json({ data: { id, status: 'CANCELLED' } });
  }),
);
