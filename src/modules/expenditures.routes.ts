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

export const expenditureRouter = Router();

expenditureRouter.use(authenticate);

interface ExpenditureRow {
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
  source: string;
  assignment_id: number | null;
  assignment_reference: string | null;
  assigned_to: string | null;
  reason: string;
  expended_date: string;
  authorised_by: string;
  notes: string;
  created_by_username: string;
  created_at: string;
}

const SELECT_EXPENDITURE = `
  SELECT x.id, x.reference, x.base_id, b.code AS base_code, b.name AS base_name,
         x.equipment_type_id, e.code AS equipment_code, e.name AS equipment_name,
         e.category AS equipment_category, e.unit AS equipment_unit,
         x.quantity, x.source, x.assignment_id, a.reference AS assignment_reference,
         pe.full_name AS assigned_to, x.reason, x.expended_date, x.authorised_by, x.notes,
         u.username AS created_by_username, x.created_at
    FROM expenditures x
    JOIN bases b          ON b.id = x.base_id
    JOIN equipment_types e ON e.id = x.equipment_type_id
    JOIN users u          ON u.id = x.created_by
    LEFT JOIN assignments a ON a.id = x.assignment_id
    LEFT JOIN personnel  pe ON pe.id = a.personnel_id`;

/** GET /api/expenditures */
expenditureRouter.get(
  '/',
  authorize(p(RESOURCES.EXPENDITURE, ACTIONS.READ)),
  validate(paginationSchema, 'query'),
  validate(reportFilterSchema.partial(), 'query'),
  asyncHandler((req, res) => {
    const filters = effectiveFilters(req as AppRequest, req.query as unknown as ReportFilters);
    const { page, pageSize, sort, order } = req.query as unknown as z.infer<typeof paginationSchema>;
    const db = getDb();

    const where: string[] = [
      'x.expended_date BETWEEN @dateFrom AND @dateTo',
      '(@baseId IS NULL OR x.base_id = @baseId)',
      '(@equipmentTypeId IS NULL OR x.equipment_type_id = @equipmentTypeId)',
      '(@category IS NULL OR e.category = @category)',
      '(@reason IS NULL OR x.reason = @reason)',
      '(@source IS NULL OR x.source = @source)',
      `(@search IS NULL OR x.reference LIKE @search OR x.authorised_by LIKE @search
        OR x.notes LIKE @search OR a.reference LIKE @search OR pe.full_name LIKE @search)`,
    ];

    const params = {
      ...filters,
      reason: typeof req.query.reason === 'string' ? req.query.reason : null,
      source: typeof req.query.source === 'string' ? req.query.source : null,
      search: filters.search ? `%${filters.search}%` : null,
    };

    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM expenditures x
             JOIN equipment_types e ON e.id = x.equipment_type_id
        LEFT JOIN assignments a  ON a.id = x.assignment_id
        LEFT JOIN personnel  pe ON pe.id = a.personnel_id
            WHERE ${where.join(' AND ')}`,
        )
        .get(params) as { n: number }
    ).n;

    const items = db
      .prepare(
        `${SELECT_EXPENDITURE} WHERE ${where.join(' AND ')}
         ORDER BY ${orderBy({ sort, order }, 'x.expended_date')}
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: pageSize, offset: offsetOf(page, pageSize) }) as ExpenditureRow[];

    const summary = db
      .prepare(
        `SELECT COUNT(*) AS document_count,
                COALESCE(SUM(x.quantity), 0) AS units_written_off
           FROM expenditures x
             JOIN equipment_types e ON e.id = x.equipment_type_id
        LEFT JOIN assignments a  ON a.id = x.assignment_id
        LEFT JOIN personnel  pe ON pe.id = a.personnel_id
          WHERE ${where.join(' AND ')}`,
      )
      .get(params) as { document_count: number; units_written_off: number };

    res.json({ data: items, meta: { ...pageMeta(total, page, pageSize), summary } });
  }),
);

/** GET /api/expenditures/meta/reasons - populates the filter dropdowns. */
expenditureRouter.get(
  '/meta/reasons',
  authorize(p(RESOURCES.EXPENDITURE, ACTIONS.READ)),
  asyncHandler((_req, res) => {
    res.json({
      data: [
        { value: 'COMBAT', label: 'Consumed in operations' },
        { value: 'TRAINING', label: 'Training / exercises' },
        { value: 'MAINTENANCE', label: 'Maintenance & servicing' },
        { value: 'LOSS', label: 'Lost or stolen' },
        { value: 'DAMAGE', label: 'Damaged beyond repair' },
        { value: 'DECOMMISSIONED', label: 'Decommissioned' },
        { value: 'OTHER', label: 'Other' },
      ],
    });
  }),
);

/** GET /api/expenditures/:id */
expenditureRouter.get(
  '/:id',
  authorize(p(RESOURCES.EXPENDITURE, ACTIONS.READ)),
  validate(z.object({ id: zId }), 'params'),
  asyncHandler((req, res) => {
    const row = getDb().prepare(`${SELECT_EXPENDITURE} WHERE x.id = ?`).get(req.params.id) as
      | ExpenditureRow
      | undefined;
    if (!row) throw notFound('Expenditure', req.params.id);
    assertWithinScope(req as AppRequest, row.base_id, `Expenditure ${row.reference}`);
    res.json({ data: row });
  }),
);

const expenditureSchema = z.object({
  baseId: zId.nullish(),
  equipmentTypeId: zId,
  quantity: zQuantity,
  source: z.enum(['DIRECT', 'ASSIGNED']).default('DIRECT'),
  assignmentId: zId.nullish(),
  reason: z.enum(['COMBAT', 'TRAINING', 'MAINTENANCE', 'LOSS', 'DAMAGE', 'DECOMMISSIONED', 'OTHER']),
  expendedDate: zIsoDate,
  authorisedBy: z.string().trim().max(120).default(''),
  notes: zText,
});

/**
 * POST /api/expenditures - write assets off.
 *
 * This is the only operation that permanently reduces on-hand stock, so it is
 * the one the dashboard's Closing Balance depends on:
 *
 *   Closing = Opening + (Purchases + Transfer In - Transfer Out) - Expended
 *
 * Two consumption paths, both audited:
 *   source = 'DIRECT'    - written off from base stock, never issued.
 *   source = 'ASSIGNED'  - consumed by a servicemember under an open assignment;
 *                          reduces both on-hand and that assignment's outstanding
 *                          quantity, so the issued figure falls at the same moment.
 */
expenditureRouter.post(
  '/',
  audit('EXPENDITURE_CREATE', 'expenditure'),
  authorize(p(RESOURCES.EXPENDITURE, ACTIONS.CREATE)),
  validate(expenditureSchema),
  asyncHandler((req, res) => {
    const body = req.body as z.infer<typeof expenditureSchema>;
    const user = (req as AppRequest).user!;
    const appReq = req as AppRequest;
    const baseId = resolveTargetBaseId(appReq, body.baseId ?? null);
    const db = getDb();

    if (!db.prepare('SELECT id FROM equipment_types WHERE id = ? AND is_active = 1').get(body.equipmentTypeId)) {
      throw notFound('Equipment type', body.equipmentTypeId);
    }

    if (body.source === 'ASSIGNED' && !body.assignmentId) {
      throw conflict('Select the assignment these assets were expended under.');
    }
    if (body.source === 'DIRECT' && body.assignmentId) {
      throw conflict('An assignment may only be linked when source is ASSIGNED.');
    }

    if (body.assignmentId) {
      const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(body.assignmentId) as
        | Record<string, unknown>
        | undefined;
      if (!assignment) throw notFound('Assignment', body.assignmentId);
      if (assignment.base_id !== baseId || assignment.equipment_type_id !== body.equipmentTypeId) {
        throw conflict('The selected assignment is for a different base or equipment type.');
      }
      if (assignment.status === 'CANCELLED' || assignment.status === 'RETURNED') {
        throw invalidStateTransition(`Assignment ${assignment.reference as string} is closed.`);
      }

      const outstanding =
        (assignment.quantity as number) -
        (assignment.quantity_returned as number) -
        (assignment.quantity_expended as number);
      if (body.quantity > outstanding) {
        throw conflict(
          `Only ${outstanding} unit(s) are outstanding on ${assignment.reference as string}; ${body.quantity} requested.`,
        );
      }
    }

    const result = inTransaction((tx) => {
      const reference = nextReference(tx, 'EXPENDITURE', body.expendedDate);
      const info = tx
        .prepare(
          `INSERT INTO expenditures
             (reference, base_id, equipment_type_id, quantity, source, assignment_id,
              reason, expended_date, authorised_by, notes, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          reference,
          baseId,
          body.equipmentTypeId,
          body.quantity,
          body.source,
          body.assignmentId ?? null,
          body.reason,
          body.expendedDate,
          body.authorisedBy,
          body.notes,
          user.id,
          nowIso(),
        );
      const id = Number(info.lastInsertRowid);

      // `postLedgerEntry` raises INSUFFICIENT_STOCK if the base does not hold
      // enough, which aborts this whole transaction - no partial write-off.
      postLedgerEntry(tx, {
        baseId,
        equipmentTypeId: body.equipmentTypeId,
        txnType: 'EXPENDITURE',
        refType: 'EXPENDITURE',
        refId: id,
        refReference: reference,
        quantity: body.quantity,
        deltaOnHand: -body.quantity,
        deltaCommitted: body.source === 'ASSIGNED' ? -body.quantity : 0,
        effectiveDate: body.expendedDate,
        note: `${body.reason} - ${body.notes || 'no remarks'}`,
        actorId: user.id,
        requestId: appReq.ctx?.requestId ?? null,
      });

      if (body.source === 'ASSIGNED' && body.assignmentId) {
        const assignment = tx.prepare('SELECT * FROM assignments WHERE id = ?').get(body.assignmentId) as Record<
          string,
          unknown
        >;
        const expended = (assignment.quantity_expended as number) + body.quantity;
        const returned = assignment.quantity_returned as number;
        const quantity = assignment.quantity as number;
        const status = returned + expended >= quantity ? 'EXPENDED' : 'PARTIALLY_RETURNED';

        tx.prepare(
          `UPDATE assignments SET quantity_expended = ?, status = ?, updated_at = ? WHERE id = ?`,
        ).run(expended, status, nowIso(), body.assignmentId);
      }

      return { id, reference };
    });

    recordAuditedEntity(req, result.id, {
      reference: result.reference,
      baseId,
      equipmentTypeId: body.equipmentTypeId,
      quantity: body.quantity,
      source: body.source,
      reason: body.reason,
    });

    res.status(201).json({ data: { id: result.id, reference: result.reference } });
  }),
);

