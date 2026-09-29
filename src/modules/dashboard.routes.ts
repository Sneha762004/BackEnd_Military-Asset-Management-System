import { Router } from 'express';
import { z } from 'zod';
import { ACTIONS, RESOURCES, p } from '../config/rbac.js';
import { getDb } from '../db/connection.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/rbac.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { paginationSchema, validate } from '../middleware/validate.js';
import {
  aggregate,
  buildReconciliationQuery,
  filterParams,
  type LedgerRow,
  type MovementFilters,
  type ReconciliationRow,
} from '../services/stockService.js';
import { effectiveFilters, offsetOf, pageMeta, reportFilterSchema, type ReportFilters } from '../utils/query.js';
import type { AppRequest } from '../types/index.js';

export const dashboardRouter = Router();

dashboardRouter.use(authenticate);

function runReconciliation(filters: MovementFilters): ReconciliationRow[] {
  return getDb()
    .prepare(buildReconciliationQuery())
    .all(filterParams(filters)) as ReconciliationRow[];
}

/**
 * GET /api/dashboard/summary
 *
 * The six headline figures the requirements ask for, in one response:
 *
 *   Opening Balance      recorded position at the start of the window
 *   Net Movement         Purchases + Transfer In - Transfer Out
 *   Closing Balance      Opening + Net Movement - Expended
 *   Assigned             assets issued to personnel and still outstanding
 *   Expended             assets written off / consumed in the window
 *   Available            Closing - Assigned (what could actually be moved or issued)
 *
 * `totals_are_meaningful` is false when the filter spans more than one
 * equipment type: adding "12 rifles" to "400 rounds" is not a quantity, and
 * claiming otherwise would undermine the transparency the system exists for.
 * The UI switches to a table in that case instead of showing a bogus total.
 */
dashboardRouter.get(
  '/summary',
  authorize(p(RESOURCES.DASHBOARD, ACTIONS.READ)),
  validate(reportFilterSchema.partial(), 'query'),
  asyncHandler((req, res) => {
    const appReq = req as AppRequest;
    const filters = effectiveFilters(appReq, req.query as unknown as ReportFilters);
    const rows = runReconciliation(filters);
    const uniform = filters.equipmentTypeId !== null;
    const totals = aggregate(rows, filters.equipmentTypeId, uniform);

    const db = getDb();

    const transfersInFlight = db
      .prepare(
        `SELECT COUNT(*) AS documents,
                COALESCE(SUM(ti.quantity), 0) AS units
           FROM transfers t
           JOIN transfer_items ti ON ti.transfer_id = t.id
          WHERE t.status = 'IN_TRANSIT'
            AND t.transfer_date BETWEEN @dateFrom AND @dateTo
            AND (@baseId IS NULL OR t.from_base_id = @baseId OR t.to_base_id = @baseId)`,
      )
      .get({ dateFrom: filters.dateFrom, dateTo: filters.dateTo, baseId: filters.baseId }) as {
      documents: number;
      units: number;
    };

    const assignmentsOutstanding = db
      .prepare(
        `SELECT COUNT(*) AS documents,
                COALESCE(SUM(a.quantity - a.quantity_returned - a.quantity_expended), 0) AS units
           FROM assignments a
          WHERE a.status IN ('ACTIVE', 'PARTIALLY_RETURNED')
            AND a.assigned_date BETWEEN @dateFrom AND @dateTo
            AND (@baseId IS NULL OR a.base_id = @baseId)`,
      )
      .get({ dateFrom: filters.dateFrom, dateTo: filters.dateTo, baseId: filters.baseId }) as {
      documents: number;
      units: number;
    };

    res.json({
      data: {
        filters,
        scope: {
          role: appReq.user!.role,
          baseId: appReq.user!.baseId,
          baseLabel: appReq.user!.baseCode ?? 'All bases',
        },
        totals,
        document_counts: {
          purchases: db
            .prepare(
              `SELECT COUNT(*) AS n FROM purchases
                WHERE status = 'RECEIVED' AND received_date BETWEEN @dateFrom AND @dateTo
                  AND (@baseId IS NULL OR base_id = @baseId)`,
            )
            .get({ dateFrom: filters.dateFrom, dateTo: filters.dateTo, baseId: filters.baseId }) as { n: number },
          transfers: transfersInFlight,
          assignments: assignmentsOutstanding,
          expenditures: db
            .prepare(
              `SELECT COUNT(*) AS n FROM expenditures
                WHERE expended_date BETWEEN @dateFrom AND @dateTo
                  AND (@baseId IS NULL OR base_id = @baseId)`,
            )
            .get({ dateFrom: filters.dateFrom, dateTo: filters.dateTo, baseId: filters.baseId }) as { n: number },
        },
      },
    });
  }),
);

/**
 * GET /api/dashboard/net-movement
 *
 * The drill-down behind the "Net Movement" card: the individual Purchases,
 * Transfer In and Transfer Out documents that make up the single netted number,
 * with the running contribution of each so the arithmetic is visible. This is
 * the "transparency" requirement made literal - a commander can see exactly
 * which receipt produced which movement.
 */
dashboardRouter.get(
  '/net-movement',
  authorize(p(RESOURCES.DASHBOARD, ACTIONS.READ)),
  validate(paginationSchema, 'query'),
  validate(reportFilterSchema.partial(), 'query'),
  asyncHandler((req, res) => {
    const filters = effectiveFilters(req as AppRequest, req.query as unknown as ReportFilters);
    const { page, pageSize } = req.query as unknown as z.infer<typeof paginationSchema>;
    const db = getDb();

    const scope = `
      AND (@baseId IS NULL OR l.base_id = @baseId)
      AND (@equipmentTypeId IS NULL OR l.equipment_type_id = @equipmentTypeId)
      AND (@category IS NULL OR EXISTS (
            SELECT 1 FROM equipment_types et
             WHERE et.id = l.equipment_type_id AND et.category = @category))
      AND l.txn_type IN ('PURCHASE', 'TRANSFER_IN', 'TRANSFER_OUT')`;

    const baseParams = {
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      baseId: filters.baseId,
      equipmentTypeId: filters.equipmentTypeId,
      category: filters.category,
    };

    const byKind = db
      .prepare(
        `SELECT l.txn_type AS kind, COALESCE(SUM(l.quantity), 0) AS units
           FROM stock_ledger l
          WHERE l.effective_date BETWEEN @dateFrom AND @dateTo ${scope}
          GROUP BY l.txn_type`,
      )
      .all(baseParams) as { kind: string; units: number }[];

    const kindUnits = new Map(byKind.map((row) => [row.kind, row.units]));
    const purchases = kindUnits.get('PURCHASE') ?? 0;
    const transferIn = kindUnits.get('TRANSFER_IN') ?? 0;
    const transferOut = kindUnits.get('TRANSFER_OUT') ?? 0;

    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM stock_ledger l
            WHERE l.effective_date BETWEEN @dateFrom AND @dateTo ${scope}`,
        )
        .get(baseParams) as { n: number }
    ).n;

    const movements = db
      .prepare(
        `SELECT l.id, l.txn_type, l.ref_type, l.ref_id, l.ref_reference, l.quantity,
                l.direction, l.delta_on_hand, l.effective_date, l.note, l.created_at,
                b.code AS base_code, b.name AS base_name,
                e.code AS equipment_code, e.name AS equipment_name, e.unit AS equipment_unit,
                l.actor_id, u.username AS actor_username
           FROM stock_ledger l
           JOIN bases b          ON b.id = l.base_id
           JOIN equipment_types e ON e.id = l.equipment_type_id
      LEFT JOIN users u          ON u.id = l.actor_id
          WHERE l.effective_date BETWEEN @dateFrom AND @dateTo ${scope}
       ORDER BY l.effective_date DESC, l.id DESC
          LIMIT @limit OFFSET @offset`,
      )
      .all({ ...baseParams, limit: pageSize, offset: offsetOf(page, pageSize) }) as Array<LedgerRow & {
      base_code: string;
      equipment_code: string;
    }>;

    res.json({
      data: movements,
      meta: {
        ...pageMeta(total, page, pageSize),
        breakdown: {
          purchases,
          transfer_in: transferIn,
          transfer_out: transferOut,
          net_movement: purchases + transferIn - transferOut,
          formula: 'net movement = purchases + transfer in - transfer out',
        },
      },
    });
  }),
);

/** GET /api/dashboard/by-equipment - the reconciliation table, per equipment type. */
dashboardRouter.get(
  '/by-equipment',
  authorize(p(RESOURCES.DASHBOARD, ACTIONS.READ)),
  validate(reportFilterSchema.partial(), 'query'),
  asyncHandler((req, res) => {
    const filters = effectiveFilters(req as AppRequest, req.query as unknown as ReportFilters);
    const rows = runReconciliation(filters);

    const grouped = new Map<number, ReconciliationRow & { net_movement: number; available: number }>();
    for (const row of rows) {
      const existing = grouped.get(row.equipment_type_id);
      if (existing) {
        existing.opening_balance += row.opening_balance;
        existing.purchases += row.purchases;
        existing.transfer_in += row.transfer_in;
        existing.transfer_out += row.transfer_out;
        existing.expended += row.expended;
        existing.assigned += row.assigned;
        existing.closing_balance += row.closing_balance;
      } else {
        grouped.set(row.equipment_type_id, {
          ...row,
          base_id: 0,
          base_code: '',
          base_name: '',
          net_movement: 0,
          available: 0,
        });
      }
    }

    const data = [...grouped.values()].map((row) => {
      const net = row.purchases + row.transfer_in - row.transfer_out;
      return { ...row, net_movement: net, available: row.closing_balance - row.assigned };
    });

    data.sort((a, b) => a.equipment_name.localeCompare(b.equipment_name));
    res.json({ data });
  }),
);

/** GET /api/dashboard/by-base - the same walk-down, grouped by installation. */
dashboardRouter.get(
  '/by-base',
  authorize(p(RESOURCES.DASHBOARD, ACTIONS.READ)),
  validate(reportFilterSchema.partial(), 'query'),
  asyncHandler((req, res) => {
    const filters = effectiveFilters(req as AppRequest, req.query as unknown as ReportFilters);
    const rows = runReconciliation(filters);

    const grouped = new Map<number, ReconciliationRow>();
    for (const row of rows) {
      const existing = grouped.get(row.base_id);
      if (existing) {
        existing.opening_balance += row.opening_balance;
        existing.purchases += row.purchases;
        existing.transfer_in += row.transfer_in;
        existing.transfer_out += row.transfer_out;
        existing.expended += row.expended;
        existing.assigned += row.assigned;
        existing.closing_balance += row.closing_balance;
      } else {
        grouped.set(row.base_id, { ...row, equipment_code: '', equipment_name: '', equipment_unit: '' });
      }
    }

    const data = [...grouped.values()].map((row) => {
      const net = row.purchases + row.transfer_in - row.transfer_out;
      return {
        base_id: row.base_id,
        base_code: row.base_code,
        base_name: row.base_name,
        opening_balance: row.opening_balance,
        purchases: row.purchases,
        transfer_in: row.transfer_in,
        transfer_out: row.transfer_out,
        net_movement: net,
        expended: row.expended,
        closing_balance: row.closing_balance,
        assigned: row.assigned,
        available: row.closing_balance - row.assigned,
      };
    });

    data.sort((a, b) => b.closing_balance - a.closing_balance);
    res.json({ data });
  }),
);

/** GET /api/dashboard/trend - monthly net movement series for the chart. */
dashboardRouter.get(
  '/trend',
  authorize(p(RESOURCES.DASHBOARD, ACTIONS.READ)),
  validate(reportFilterSchema.partial(), 'query'),
  validate(z.object({ months: z.coerce.number().int().min(3).max(24).default(6) }), 'query'),
  asyncHandler((req, res) => {
    const appReq = req as AppRequest;
    const raw = req.query as unknown as ReportFilters & { months: number };
    const filters = effectiveFilters(appReq, raw);
    const months = raw.months ?? 6;

    // The trend deliberately ignores the date filter and walks back `months`
    // whole periods from the window end, so the chart always has a consistent
    // x-axis regardless of the range chosen for the KPI cards above it.
    const end = new Date(`${filters.dateTo}T00:00:00Z`);
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (months - 1), 1));

    const rows = getDb()
      .prepare(
        `SELECT substr(l.effective_date, 1, 7) AS period,
                l.txn_type,
                COALESCE(SUM(l.quantity), 0) AS units
           FROM stock_ledger l
          WHERE l.effective_date >= @startDate
            AND l.effective_date <= @endDate
            AND (@baseId IS NULL OR l.base_id = @baseId)
            AND (@equipmentTypeId IS NULL OR l.equipment_type_id = @equipmentTypeId)
            AND (@category IS NULL OR EXISTS (
                  SELECT 1 FROM equipment_types et
                   WHERE et.id = l.equipment_type_id AND et.category = @category))
            AND l.txn_type IN ('PURCHASE', 'TRANSFER_IN', 'TRANSFER_OUT', 'EXPENDITURE')
       GROUP BY period, l.txn_type
       ORDER BY period`,
      )
      .all({
        startDate: start.toISOString().slice(0, 10),
        endDate: filters.dateTo,
        baseId: filters.baseId,
        equipmentTypeId: filters.equipmentTypeId,
        category: filters.category,
      }) as { period: string; txn_type: string; units: number }[];

    interface TrendBucket {
      purchases: number;
      transfer_in: number;
      transfer_out: number;
      expended: number;
    }

    // Ledger transaction type -> trend bucket key. Explicit on purpose: see
    // the note at the assignment below.
    const TREND_KEY: Record<string, keyof TrendBucket> = {
      PURCHASE: 'purchases',
      TRANSFER_IN: 'transfer_in',
      TRANSFER_OUT: 'transfer_out',
      EXPENDITURE: 'expended',
    };

    const series = new Map<string, TrendBucket>();
    for (let i = 0; i < months; i += 1) {
      const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
      series.set(cursor.toISOString().slice(0, 7), {
        purchases: 0,
        transfer_in: 0,
        transfer_out: 0,
        expended: 0,
      });
    }
    for (const row of rows) {
      const bucket = series.get(row.period);
      if (!bucket) continue;
      // The ledger names its transaction types PURCHASE / TRANSFER_IN /
      // TRANSFER_OUT / EXPENDITURE, which are not the same strings as the
      // bucket keys (purchases, expended). Lower-casing is not enough - it
      // yields "purchase" and "expenditure" and silently writes to keys
      // nothing reads, leaving both series at zero and understating net
      // movement. Map explicitly so a future txn type fails loudly here
      // instead of quietly disappearing from the chart.
      const key: keyof TrendBucket | undefined = TREND_KEY[row.txn_type];
      if (!key) continue;
      bucket[key] += row.units;
    }

    const data = [...series.entries()].map(([period, values]) => ({
      period,
      ...values,
      net_movement: values.purchases + values.transfer_in - values.transfer_out,
    }));

    res.json({ data, meta: { months, unit_note: 'Quantities are summed across equipment types.' } });
  }),
);

/** GET /api/dashboard/movements - the live movement feed (stock ledger). */
dashboardRouter.get(
  '/movements',
  authorize(p(RESOURCES.DASHBOARD, ACTIONS.READ)),
  validate(paginationSchema, 'query'),
  validate(reportFilterSchema.partial(), 'query'),
  asyncHandler((req, res) => {
    const filters = effectiveFilters(req as AppRequest, req.query as unknown as ReportFilters);
    const { page, pageSize } = req.query as unknown as z.infer<typeof paginationSchema>;
    const db = getDb();

    const where = `
      l.effective_date BETWEEN @dateFrom AND @dateTo
      AND (@baseId IS NULL OR l.base_id = @baseId)
      AND (@equipmentTypeId IS NULL OR l.equipment_type_id = @equipmentTypeId)
      AND (@category IS NULL OR EXISTS (
            SELECT 1 FROM equipment_types et
             WHERE et.id = l.equipment_type_id AND et.category = @category))
      AND (@txnType IS NULL OR l.txn_type = @txnType)`;

    const params = {
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      baseId: filters.baseId,
      equipmentTypeId: filters.equipmentTypeId,
      category: filters.category,
      txnType: typeof req.query.txnType === 'string' ? req.query.txnType : null,
    };

    const total = (db.prepare(`SELECT COUNT(*) AS n FROM stock_ledger l WHERE ${where}`).get(params) as { n: number })
      .n;

    const items = db
      .prepare(
        `SELECT l.id, l.txn_type, l.ref_type, l.ref_id, l.ref_reference, l.quantity,
                l.direction, l.delta_on_hand, l.delta_committed, l.balance_on_hand,
                l.balance_committed, l.effective_date, l.note, l.created_at, l.request_id,
                b.code AS base_code, b.name AS base_name,
                e.code AS equipment_code, e.name AS equipment_name,
                e.category AS equipment_category, e.unit AS equipment_unit,
                u.username AS actor_username
           FROM stock_ledger l
           JOIN bases b          ON b.id = l.base_id
           JOIN equipment_types e ON e.id = l.equipment_type_id
      LEFT JOIN users u          ON u.id = l.actor_id
          WHERE ${where}
       ORDER BY l.effective_date DESC, l.id DESC
          LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: pageSize, offset: offsetOf(page, pageSize) }) as LedgerRow[];

    res.json({ data: items, meta: pageMeta(total, page, pageSize) });
  }),
);
