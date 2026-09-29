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
import { conflict, invalidStateTransition, notFound } from '../utils/errors.js';
import { nextReference } from '../utils/reference.js';
import { getBalances, postLedgerEntry } from '../services/stockService.js';
import {
  effectiveFilters,
  offsetOf,
  orderBy,
  pageMeta,
  reportFilterSchema,
  type ReportFilters,
} from '../utils/query.js';
import type { AppRequest } from '../types/index.js';

export const assignmentRouter = Router();

assignmentRouter.use(authenticate);

interface AssignmentRow {
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
  personnel_id: number;
  service_number: string;
  personnel_name: string;
  personnel_rank: string;
  unit: string;
  quantity: number;
  quantity_returned: number;
  quantity_expended: number;
  quantity_outstanding: number;
  status: string;
  assigned_date: string;
  due_date: string | null;
  returned_date: string | null;
  purpose: string;
  notes: string;
  created_by_username: string;
  created_at: string;
}

const SELECT_ASSIGNMENT = `
  SELECT a.id, a.reference, a.base_id, b.code AS base_code, b.name AS base_name,
         a.equipment_type_id, e.code AS equipment_code, e.name AS equipment_name,
         e.category AS equipment_category, e.unit AS equipment_unit,
         a.personnel_id, p.service_number, p.full_name AS personnel_name,
         p.rank AS personnel_rank, p.unit,
         a.quantity, a.quantity_returned, a.quantity_expended,
         (a.quantity - a.quantity_returned - a.quantity_expended) AS quantity_outstanding,
         a.status, a.assigned_date, a.due_date, a.returned_date,
         a.purpose, a.notes, u.username AS created_by_username, a.created_at
    FROM assignments a
    JOIN bases b          ON b.id = a.base_id
    JOIN equipment_types e ON e.id = a.equipment_type_id
    JOIN personnel p      ON p.id = a.personnel_id
    JOIN users u          ON u.id = a.created_by`;

/** GET /api/assignments */
assignmentRouter.get(
  '/',
  authorize(p(RESOURCES.ASSIGNMENT, ACTIONS.READ)),
  validate(paginationSchema, 'query'),
  validate(reportFilterSchema.partial(), 'query'),
  asyncHandler((req, res) => {
    const filters = effectiveFilters(req as AppRequest, req.query as unknown as ReportFilters);
    const { page, pageSize, sort, order } = req.query as unknown as z.infer<typeof paginationSchema>;
    const db = getDb();

    const where: string[] = [
      'a.assigned_date BETWEEN @dateFrom AND @dateTo',
      '(@baseId IS NULL OR a.base_id = @baseId)',
      '(@equipmentTypeId IS NULL OR a.equipment_type_id = @equipmentTypeId)',
      '(@category IS NULL OR e.category = @category)',
      '(@status IS NULL OR a.status = @status)',
      `(@search IS NULL OR a.reference LIKE @search OR p.full_name LIKE @search
        OR p.service_number LIKE @search OR a.purpose LIKE @search)`,
    ];

    const params = { ...filters, search: filters.search ? `%${filters.search}%` : null };

    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM assignments a
             JOIN equipment_types e ON e.id = a.equipment_type_id
             JOIN personnel p ON p.id = a.personnel_id
            WHERE ${where.join(' AND ')}`,
        )
        .get(params) as { n: number }
    ).n;

    const items = db
      .prepare(
        `${SELECT_ASSIGNMENT} WHERE ${where.join(' AND ')}
         ORDER BY ${orderBy({ sort, order }, 'a.assigned_date')}
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: pageSize, offset: offsetOf(page, pageSize) }) as AssignmentRow[];

    const summary = db
      .prepare(
        `SELECT COUNT(*) AS document_count,
                COALESCE(SUM(a.quantity), 0) AS units_issued,
                COALESCE(SUM(a.quantity - a.quantity_returned - a.quantity_expended), 0) AS units_outstanding,
                COALESCE(SUM(CASE WHEN a.status = 'ACTIVE' THEN 1 END), 0) AS active_count
           FROM assignments a
           JOIN equipment_types e ON e.id = a.equipment_type_id
           JOIN personnel p ON p.id = a.personnel_id
          WHERE ${where.join(' AND ')} AND a.status NOT IN ('CANCELLED')`,
      )
      .get(params) as { document_count: number; units_issued: number; units_outstanding: number; active_count: number };

    res.json({ data: items, meta: { ...pageMeta(total, page, pageSize), summary } });
  }),
);

/** GET /api/assignments/:id */
assignmentRouter.get(
  '/:id',
  authorize(p(RESOURCES.ASSIGNMENT, ACTIONS.READ)),
  validate(z.object({ id: zId }), 'params'),
  asyncHandler((req, res) => {
    const row = getDb().prepare(`${SELECT_ASSIGNMENT} WHERE a.id = ?`).get(req.params.id) as
      | AssignmentRow
      | undefined;
    if (!row) throw notFound('Assignment', req.params.id);
    assertWithinScope(req as AppRequest, row.base_id, `Assignment ${row.reference}`);
    res.json({ data: row });
  }),
);

const assignmentSchema = z
  .object({
    baseId: zId.nullish(),
    equipmentTypeId: zId,
    personnelId: zId,
    quantity: zQuantity,
    assignedDate: zIsoDate,
    dueDate: zIsoDate.nullish(),
    purpose: z.string().trim().max(200).default(''),
    notes: zText,
  })
  .refine((value) => !value.dueDate || value.dueDate >= value.assignedDate, {
    message: 'Return-by date cannot precede the assignment date',
    path: ['dueDate'],
  });

/**
 * POST /api/assignments - issue assets to a named servicemember.
 *
 * Accounting note: issuing an asset does **not** reduce the base's on-hand
 * figure. The base still holds the asset and remains accountable for it, so
 * `on_hand` is unchanged while `committed` rises. The consequence is that the
 * asset stops being *transferable* - `assertTransferableStock` refuses to load
 * onto a truck something that is in a soldier's hands - but it stays visible in
 * every balance and in the "Assigned" KPI. This is what makes the dashboard's
 * Assigned figure meaningful instead of double-counted.
 */
assignmentRouter.post(
  '/',
  audit('ASSIGNMENT_CREATE', 'assignment'),
  authorize(p(RESOURCES.ASSIGNMENT, ACTIONS.CREATE)),
  validate(assignmentSchema),
  asyncHandler((req, res) => {
    const body = req.body as z.infer<typeof assignmentSchema>;
    const user = (req as AppRequest).user!;
    const appReq = req as AppRequest;
    const baseId = resolveTargetBaseId(appReq, body.baseId ?? null);
    const db = getDb();

    const person = db
      .prepare('SELECT id, base_id, full_name FROM personnel WHERE id = ? AND is_active = 1')
      .get(body.personnelId) as { id: number; base_id: number; full_name: string } | undefined;
    if (!person) throw notFound('Personnel', body.personnelId);
    if (person.base_id !== baseId) {
      throw conflict(
        `${person.full_name} is not posted to the selected base; issue the asset from their own base.`,
      );
    }

    if (!db.prepare('SELECT id FROM equipment_types WHERE id = ? AND is_active = 1').get(body.equipmentTypeId)) {
      throw notFound('Equipment type', body.equipmentTypeId);
    }

    const result = inTransaction((tx) => {
      const { available } = getBalances(tx, baseId, body.equipmentTypeId);
      if (available < body.quantity) {
        throw conflict(
          `Only ${available} unit(s) are available to issue (units already issued to other personnel are not transferable).`,
          { available, requested: body.quantity },
        );
      }

      const reference = nextReference(tx, 'ASSIGNMENT', body.assignedDate);
      const info = tx
        .prepare(
          `INSERT INTO assignments
             (reference, base_id, equipment_type_id, personnel_id, quantity, status,
              assigned_date, due_date, purpose, notes, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          reference,
          baseId,
          body.equipmentTypeId,
          body.personnelId,
          body.quantity,
          body.assignedDate,
          body.dueDate ?? null,
          body.purpose,
          body.notes,
          user.id,
          nowIso(),
          nowIso(),
        );
      const id = Number(info.lastInsertRowid);

      postLedgerEntry(tx, {
        baseId,
        equipmentTypeId: body.equipmentTypeId,
        txnType: 'ASSIGNMENT',
        refType: 'ASSIGNMENT',
        refId: id,
        refReference: reference,
        quantity: body.quantity,
        deltaOnHand: 0,
        deltaCommitted: body.quantity,
        effectiveDate: body.assignedDate,
        note: `Issued to ${person.full_name}`,
        actorId: user.id,
        requestId: appReq.ctx?.requestId ?? null,
      });

      return { id, reference };
    });

    recordAuditedEntity(req, result.id, {
      reference: result.reference,
      baseId,
      equipmentTypeId: body.equipmentTypeId,
      personnelId: body.personnelId,
      quantity: body.quantity,
    });

    res.status(201).json({ data: { id: result.id, reference: result.reference, status: 'ACTIVE' } });
  }),
);

const returnSchema = z.object({
  returnedDate: zIsoDate,
  quantity: zQuantity,
  notes: zText,
});

/**
 * POST /api/assignments/:id/return - assets come back into base custody.
 *
 * On-hand is unchanged (they were never off the books); committed falls. The
 * asset becomes transferable again.
 */
assignmentRouter.post(
  '/:id/return',
  audit('ASSIGNMENT_RETURN', 'assignment'),
  authorize(p(RESOURCES.ASSIGNMENT, ACTIONS.UPDATE)),
  validate(z.object({ id: zId }), 'params'),
  validate(returnSchema),
  asyncHandler((req, res) => {
    const id = Number(req.params.id);
    const body = req.body as z.infer<typeof returnSchema>;
    const user = (req as AppRequest).user!;
    const appReq = req as AppRequest;
    const db = getDb();

    const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!assignment) throw notFound('Assignment', id);
    assertWithinScope(appReq, assignment.base_id as number, `Assignment ${assignment.reference as string}`);

    const status = assignment.status as string;
    if (status === 'CANCELLED' || status === 'RETURNED') {
      throw invalidStateTransition(`Assignment ${assignment.reference as string} is already ${status}.`);
    }

    const outstanding =
      (assignment.quantity as number) - (assignment.quantity_returned as number) - (assignment.quantity_expended as number);
    if (body.quantity > outstanding) {
      throw conflict(`Only ${outstanding} unit(s) are outstanding on this assignment.`);
    }

    const nextStatus =
      body.quantity === outstanding
        ? 'RETURNED'
        : (assignment.quantity_returned as number) + body.quantity > 0
          ? 'PARTIALLY_RETURNED'
          : status;

    inTransaction((tx) => {
      const returned = (assignment.quantity_returned as number) + body.quantity;

      tx.prepare(
        `UPDATE assignments
            SET quantity_returned = @returned, status = @status, returned_date = @returnedDate,
                notes = CASE WHEN @extraNotes = '' THEN notes ELSE notes || ' | ' || @extraNotes END,
                updated_at = @updatedAt
          WHERE id = @id`,
      ).run({
        id,
        returned,
        status: nextStatus,
        returnedDate: body.quantity === outstanding ? body.returnedDate : (assignment.returned_date as string | null),
        extraNotes: body.notes,
        updatedAt: nowIso(),
      });

      postLedgerEntry(tx, {
        baseId: assignment.base_id as number,
        equipmentTypeId: assignment.equipment_type_id as number,
        txnType: 'RETURN',
        refType: 'ASSIGNMENT',
        refId: id,
        refReference: assignment.reference as string,
        quantity: body.quantity,
        deltaOnHand: 0,
        deltaCommitted: -body.quantity,
        effectiveDate: body.returnedDate,
        note: 'Returned to base custody',
        actorId: user.id,
        requestId: appReq.ctx?.requestId ?? null,
      });
    });

    recordAuditedEntity(req, id, { status: nextStatus, returned: body.quantity });
    res.json({ data: { id, status: nextStatus, quantityReturned: (assignment.quantity_returned as number) + body.quantity } });
  }),
);

/** POST /api/assignments/:id/cancel - void an assignment that never happened. */
assignmentRouter.post(
  '/:id/cancel',
  audit('ASSIGNMENT_CANCEL', 'assignment'),
  authorize(p(RESOURCES.ASSIGNMENT, ACTIONS.UPDATE)),
  validate(z.object({ reason: zShortText.max(300) })),
  asyncHandler((req, res) => {
    const id = Number(req.params.id);
    const { reason } = req.body as { reason: string };
    const user = (req as AppRequest).user!;
    const appReq = req as AppRequest;
    const db = getDb();

    const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!assignment) throw notFound('Assignment', id);
    assertWithinScope(appReq, assignment.base_id as number, `Assignment ${assignment.reference as string}`);

    const quantityReturned = assignment.quantity_returned as number;
    const quantityExpended = assignment.quantity_expended as number;
    if (quantityReturned > 0 || quantityExpended > 0) {
      throw invalidStateTransition(
        'This assignment has movements against it; return or write off the assets instead of cancelling it.',
      );
    }

    inTransaction((tx) => {
      tx.prepare(
        `UPDATE assignments SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?, updated_at = ? WHERE id = ?`,
      ).run(user.id, nowIso(), nowIso(), id);

      postLedgerEntry(tx, {
        baseId: assignment.base_id as number,
        equipmentTypeId: assignment.equipment_type_id as number,
        txnType: 'ADJUSTMENT',
        refType: 'ASSIGNMENT',
        refId: id,
        refReference: assignment.reference as string,
        quantity: assignment.quantity as number,
        deltaOnHand: 0,
        deltaCommitted: -(assignment.quantity as number),
        effectiveDate: new Date().toISOString().slice(0, 10),
        note: `Reversal of ${assignment.reference as string}: ${reason}`,
        actorId: user.id,
        requestId: appReq.ctx?.requestId ?? null,
      });
    });

    recordAuditedEntity(req, id, { status: 'CANCELLED', reason });
    res.json({ data: { id, status: 'CANCELLED' } });
  }),
);
