import type { Db } from '../db/connection.js';
import { insufficientStock } from '../utils/errors.js';

/** Signed movement kinds understood by the ledger. */
export type LedgerTxnType =
  | 'OPENING_BALANCE'
  | 'PURCHASE'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'ASSIGNMENT'
  | 'RETURN'
  | 'EXPENDITURE'
  | 'ADJUSTMENT';

export type LedgerRefType = 'OPENING_BALANCE' | 'PURCHASE' | 'TRANSFER' | 'ASSIGNMENT' | 'EXPENDITURE' | 'ADJUSTMENT';

export interface LedgerEntry {
  baseId: number;
  equipmentTypeId: number;
  txnType: LedgerTxnType;
  refType: LedgerRefType;
  refId: number;
  refReference?: string;
  quantity: number;
  /** Signed. Negative for anything leaving the base's on-hand position. */
  deltaOnHand: number;
  /** Signed effect on the committed (issued-to-personnel) position. */
  deltaCommitted?: number;
  effectiveDate: string;
  note?: string;
  actorId?: number | null;
  requestId?: string | null;
}

export interface LedgerRow {
  id: number;
  base_id: number;
  base_code: string;
  base_name: string;
  equipment_type_id: number;
  equipment_code: string;
  equipment_name: string;
  equipment_category: string;
  equipment_unit: string;
  txn_type: LedgerTxnType;
  ref_type: LedgerRefType;
  ref_id: number;
  ref_reference: string;
  quantity: number;
  direction: 'IN' | 'OUT';
  delta_on_hand: number;
  delta_committed: number;
  balance_on_hand: number;
  balance_committed: number;
  effective_date: string;
  note: string;
  actor_username: string | null;
  request_id: string | null;
  created_at: string;
}

export function getBalances(db: Db, baseId: number, equipmentTypeId: number) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(delta_on_hand), 0)   AS on_hand,
              COALESCE(SUM(delta_committed), 0) AS committed
         FROM stock_ledger
        WHERE base_id = ? AND equipment_type_id = ?`,
    )
    .get(baseId, equipmentTypeId) as { on_hand: number; committed: number };

  return { onHand: row.on_hand, committed: row.committed, available: row.on_hand - row.committed };
}

/**
 * Posts one line to the append-only ledger and returns the new running balance.
 *
 * The `balance_on_hand >= 0` invariant is enforced twice: here (so the caller
 * gets a domain error it can present) and by a CHECK constraint in the schema
 * (so nothing can bypass the service layer).
 *
 * `balance_on_hand` is the balance **in posting order**, i.e. the physical
 * position of the base at the moment the line was written. Date-ordered
 * balances for reporting are derived from `delta_on_hand` in the reporting
 * queries, which stay correct even when documents are back-dated.
 */
export function postLedgerEntry(db: Db, entry: LedgerEntry) {
  if (!Number.isInteger(entry.quantity) || entry.quantity <= 0) {
    throw new Error('Ledger quantity must be a positive integer');
  }

  const { onHand, committed } = getBalances(db, entry.baseId, entry.equipmentTypeId);
  const deltaCommitted = entry.deltaCommitted ?? 0;
  const newOnHand = onHand + entry.deltaOnHand;
  const newCommitted = committed + deltaCommitted;

  if (newOnHand < 0) {
    throw insufficientStock(
      `Insufficient stock at this base: on hand ${onHand}, requested ${Math.abs(entry.deltaOnHand)}.`,
      { baseId: entry.baseId, equipmentTypeId: entry.equipmentTypeId, onHand, requested: Math.abs(entry.deltaOnHand) },
    );
  }
  if (newCommitted < 0) {
    throw insufficientStock('Insufficient committed stock to release.', {
      baseId: entry.baseId,
      equipmentTypeId: entry.equipmentTypeId,
      committed,
    });
  }

  const info = db
    .prepare(
      `INSERT INTO stock_ledger
         (base_id, equipment_type_id, txn_type, ref_type, ref_id, ref_reference,
          quantity, direction, delta_on_hand, delta_committed,
          balance_on_hand, balance_committed, effective_date, note, actor_id, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.baseId,
      entry.equipmentTypeId,
      entry.txnType,
      entry.refType,
      entry.refId,
      entry.refReference ?? '',
      entry.quantity,
      entry.deltaOnHand >= 0 ? 'IN' : 'OUT',
      entry.deltaOnHand,
      deltaCommitted,
      newOnHand,
      newCommitted,
      entry.effectiveDate,
      entry.note ?? '',
      entry.actorId ?? null,
      entry.requestId ?? null,
    );

  return { id: Number(info.lastInsertRowid), onHand: newOnHand, committed: newCommitted };
}

/**
 * Availability check for outbound movement.
 *
 * Transfers may only draw on *uncommitted* stock: assets already issued to a
 * servicemember are still on the books at the base, but physically they are in
 * the hands of that servicemember, so they cannot be loaded onto a truck.
 * Expenditure is allowed against the full on-hand figure because writing off an
 * issued asset is exactly the `source = 'ASSIGNED'` case.
 */
export function assertTransferableStock(db: Db, baseId: number, equipmentTypeId: number, quantity: number, label: string) {
  const { onHand, committed, available } = getBalances(db, baseId, equipmentTypeId);
  if (available < quantity) {
    throw insufficientStock(
      `Cannot ${label} ${quantity} unit(s): ${available} available (${onHand} on hand, ${committed} already issued to personnel).`,
      { baseId, equipmentTypeId, onHand, committed, available, requested: quantity },
    );
  }
}

export function assertOnHandStock(db: Db, baseId: number, equipmentTypeId: number, quantity: number) {
  const { onHand } = getBalances(db, baseId, equipmentTypeId);
  if (onHand < quantity) {
    throw insufficientStock(`Only ${onHand} unit(s) on hand; ${quantity} requested.`, {
      baseId,
      equipmentTypeId,
      onHand,
      requested: quantity,
    });
  }
}

/** Shared, always-present filter fragment for the reporting queries. */
export interface MovementFilters {
  /** ISO date, inclusive. Defaults to the first day of the current month. */
  dateFrom: string;
  /** ISO date, inclusive. Defaults to today. */
  dateTo: string;
  /** `null` = every base the caller may see. */
  baseId: number | null;
  equipmentTypeId: number | null;
  category: string | null;
}

export const DEFAULT_FILTERS: MovementFilters = {
  dateFrom: `${new Date().toISOString().slice(0, 7)}-01`,
  dateTo: new Date().toISOString().slice(0, 10),
  baseId: null,
  equipmentTypeId: null,
  category: null,
};

/** `2026-04-17` -> `2026-04-01`. */
export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Scope predicate against a `stock_ledger l` alias. */
const ledgerScopeFilter = `
  (:baseId IS NULL OR l.base_id = :baseId)
  AND (:equipmentTypeId IS NULL OR l.equipment_type_id = :equipmentTypeId)
  AND (:category IS NULL OR EXISTS (
        SELECT 1 FROM equipment_types et
         WHERE et.id = l.equipment_type_id AND et.category = :category))`;

/** Same predicate against an `opening_balances ob` alias. */
const openingScopeFilter = `
  (:baseId IS NULL OR ob.base_id = :baseId)
  AND (:equipmentTypeId IS NULL OR ob.equipment_type_id = :equipmentTypeId)
  AND (:category IS NULL OR EXISTS (
        SELECT 1 FROM equipment_types et
         WHERE et.id = ob.equipment_type_id AND et.category = :category))`;

/**
 * The reconciliation engine.
 *
 * One pass returns the full opening -> closing walk-down per
 * (base, equipment type), which the dashboard, the drill-down modal and the
 * per-equipment report all read from. Keeping it as a single query means the
 * numbers on screen can never disagree with each other.
 *
 * Opening balance is *roll-forward* aware:
 *
 *   opening(window) = recorded opening balance for the window's period
 *                   + every movement posted from that period start up to
 *                     (but not including) the window start
 *
 * so a mid-month report starts from the same reconciled position as a
 * full-month report. When no opening balance has been recorded for the period,
 * the recorded figure is 0 and the roll-forward still produces the correct
 * derived balance.
 */
export function buildReconciliationQuery() {
  return `
WITH bounds AS (
  SELECT :dateFrom AS date_from, :dateTo AS date_to, :periodStart AS period_start
),
scope AS (
  SELECT DISTINCT l.base_id, l.equipment_type_id
    FROM stock_ledger l
   WHERE 1 = 1 AND ${ledgerScopeFilter}
  UNION
  SELECT DISTINCT ob.base_id, ob.equipment_type_id
    FROM opening_balances ob
   WHERE 1 = 1 AND ${openingScopeFilter}
),
recorded_opening AS (
  SELECT ob.base_id, ob.equipment_type_id, SUM(ob.quantity) AS qty
    FROM opening_balances ob, bounds b
   WHERE ob.period_start = b.period_start
     AND 1 = 1 AND ${openingScopeFilter}
   GROUP BY ob.base_id, ob.equipment_type_id
),
carried AS (
  SELECT l.base_id, l.equipment_type_id, SUM(l.delta_on_hand) AS delta_on_hand
    FROM stock_ledger l, bounds b
   WHERE l.effective_date >= b.period_start
     AND l.effective_date <  b.date_from
     AND 1 = 1 AND ${ledgerScopeFilter}
   GROUP BY l.base_id, l.equipment_type_id
),
window_moves AS (
  SELECT l.base_id, l.equipment_type_id, l.txn_type,
         SUM(l.quantity) AS qty,
         SUM(l.delta_committed) AS delta_committed
    FROM stock_ledger l, bounds b
   WHERE l.effective_date >= b.date_from
     AND l.effective_date <= b.date_to
     AND 1 = 1 AND ${ledgerScopeFilter}
   GROUP BY l.base_id, l.equipment_type_id, l.txn_type
),
committed_at_end AS (
  SELECT l.base_id, l.equipment_type_id, SUM(l.delta_committed) AS committed
    FROM stock_ledger l, bounds b
   WHERE l.effective_date <= b.date_to
     AND 1 = 1 AND ${ledgerScopeFilter}
   GROUP BY l.base_id, l.equipment_type_id
)
SELECT
  s.base_id,
  b.code                AS base_code,
  b.name                AS base_name,
  s.equipment_type_id,
  e.code                AS equipment_code,
  e.name                AS equipment_name,
  e.category            AS equipment_category,
  e.unit                AS equipment_unit,
  COALESCE(ro.qty, 0) + COALESCE(c.delta_on_hand, 0)          AS opening_balance,
  COALESCE(SUM(CASE WHEN w.txn_type = 'PURCHASE'     THEN w.qty END), 0) AS purchases,
  COALESCE(SUM(CASE WHEN w.txn_type = 'TRANSFER_IN'  THEN w.qty END), 0) AS transfer_in,
  COALESCE(SUM(CASE WHEN w.txn_type = 'TRANSFER_OUT' THEN w.qty END), 0) AS transfer_out,
  COALESCE(SUM(CASE WHEN w.txn_type = 'EXPENDITURE'  THEN w.qty END), 0) AS expended,
  COALESCE(SUM(CASE WHEN w.txn_type = 'ASSIGNMENT'   THEN w.qty END), 0) AS assigned_in_period,
  COALESCE(SUM(CASE WHEN w.txn_type = 'RETURN'       THEN w.qty END), 0) AS returned_in_period,
  COALESCE(ce.committed, 0)                                       AS assigned,
  ( COALESCE(ro.qty, 0) + COALESCE(c.delta_on_hand, 0)
    + COALESCE(SUM(CASE WHEN w.txn_type = 'PURCHASE'     THEN w.qty END), 0)
    + COALESCE(SUM(CASE WHEN w.txn_type = 'TRANSFER_IN'  THEN w.qty END), 0)
    - COALESCE(SUM(CASE WHEN w.txn_type = 'TRANSFER_OUT' THEN w.qty END), 0)
    - COALESCE(SUM(CASE WHEN w.txn_type = 'EXPENDITURE'  THEN w.qty END), 0)
  )                                                             AS closing_balance
FROM scope s
JOIN bases b          ON b.id = s.base_id
JOIN equipment_types e ON e.id = s.equipment_type_id
LEFT JOIN recorded_opening ro ON ro.base_id = s.base_id AND ro.equipment_type_id = s.equipment_type_id
LEFT JOIN carried c          ON c.base_id  = s.base_id AND c.equipment_type_id  = s.equipment_type_id
LEFT JOIN window_moves w     ON w.base_id  = s.base_id AND w.equipment_type_id  = s.equipment_type_id
LEFT JOIN committed_at_end ce ON ce.base_id = s.base_id AND ce.equipment_type_id = s.equipment_type_id
GROUP BY s.base_id, s.equipment_type_id
`;
}

export interface ReconciliationRow {
  base_id: number;
  base_code: string;
  base_name: string;
  equipment_type_id: number;
  equipment_code: string;
  equipment_name: string;
  equipment_category: string;
  equipment_unit: string;
  opening_balance: number;
  purchases: number;
  transfer_in: number;
  transfer_out: number;
  expended: number;
  assigned_in_period: number;
  returned_in_period: number;
  assigned: number;
  closing_balance: number;
}

export function filterParams(f: MovementFilters) {
  return {
    dateFrom: f.dateFrom,
    dateTo: f.dateTo,
    periodStart: startOfMonth(f.dateFrom),
    baseId: f.baseId,
    equipmentTypeId: f.equipmentTypeId,
    category: f.category,
  };
}

/** Total quantities are only meaningful for a single equipment type. */
export function aggregate(rows: ReconciliationRow[], equipmentTypeId: number | null, uniform: boolean) {
  const base: Omit<ReconciliationRow, 'base_id' | 'base_code' | 'base_name' | 'equipment_type_id' | 'equipment_code' | 'equipment_name' | 'equipment_category' | 'equipment_unit'> = {
    opening_balance: 0,
    purchases: 0,
    transfer_in: 0,
    transfer_out: 0,
    expended: 0,
    assigned_in_period: 0,
    returned_in_period: 0,
    assigned: 0,
    closing_balance: 0,
  };

  for (const row of rows) {
    base.opening_balance += row.opening_balance;
    base.purchases += row.purchases;
    base.transfer_in += row.transfer_in;
    base.transfer_out += row.transfer_out;
    base.expended += row.expended;
    base.assigned_in_period += row.assigned_in_period;
    base.returned_in_period += row.returned_in_period;
    base.assigned += row.assigned;
    base.closing_balance += row.closing_balance;
  }

  const net_movement = base.purchases + base.transfer_in - base.transfer_out;
  const available = base.closing_balance - base.assigned;

  return {
    ...base,
    net_movement,
    available,
    /** True when summing quantities across equipment types is apples-to-apples. */
    totals_are_meaningful: uniform,
    unit: uniform ? rows[0]?.equipment_unit ?? 'unit' : 'mixed units',
  };
}
