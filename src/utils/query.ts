import { z } from 'zod';
import { zIsoDate } from '../middleware/validate.js';
import { resolveBaseScope } from '../middleware/rbac.js';
import type { AppRequest } from '../types/index.js';

/**
 * The filter set every reporting screen shares: Date range, Base and Equipment
 * Type. The dashboard requirement lists exactly these three, so they are parsed
 * once here and reused by purchases, transfers, assignments, expenditures and
 * the ledger - which is why every screen agrees on what a given date range means.
 *
 * Deliberately NOT `.strict()`: this schema is always stacked on top of
 * `paginationSchema` for the same query string, and a query string is a public
 * filter surface where an unrecognised key should be ignored, not rejected.
 * Strictness is reserved for request bodies, where an unexpected key can be an
 * attempt to set a field the caller should not control.
 */
export const reportFilterSchema = z.object({
  dateFrom: zIsoDate.optional(),
  dateTo: zIsoDate.optional(),
  baseId: z.coerce.number().int().positive().nullish(),
  equipmentTypeId: z.coerce.number().int().positive().nullish(),
  category: z.string().trim().max(30).nullish(),
  status: z.string().trim().max(30).nullish(),
  search: z.string().trim().max(120).nullish(),
});

export type ReportFilters = z.infer<typeof reportFilterSchema>;

/** ISO date for "today" in UTC - matches how dates are stored throughout. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function startOfCurrentMonth(): string {
  return `${today().slice(0, 7)}-01`;
}

/**
 * Turns request filters into the effective filter set for the caller.
 *
 * Two rules are applied here so no controller has to remember them:
 *  1. A base-scoped role can *ask* for any base, but always gets its own -
 *     a query string cannot escalate a role's scope.
 *  2. Absent dates default to the current month, which is the reporting period
 *     commanders actually ask for.
 */
export function effectiveFilters(req: AppRequest, raw: ReportFilters) {
  const scope = resolveBaseScope(req);
  const dateFrom = raw.dateFrom ?? startOfCurrentMonth();
  const dateTo = raw.dateTo ?? today();

  return {
    dateFrom,
    dateTo,
    baseId: scope.baseId ?? raw.baseId ?? null,
    equipmentTypeId: raw.equipmentTypeId ?? null,
    category: raw.category ?? null,
    status: raw.status ?? null,
    search: raw.search ?? null,
  };
}

export interface SortSpec {
  sort?: string;
  order?: 'asc' | 'desc';
}

const SORTABLE = new Set([
  'created_at',
  'reference',
  'quantity',
  'purchase_date',
  'received_date',
  'transfer_date',
  'assigned_date',
  'expended_date',
  'effective_date',
  'total_cost',
  'base_name',
  'equipment_name',
  'status',
]);

/**
 * Whitelisted ORDER BY. Never interpolate a client string into SQL - resolve it
 * against this allow-list so `?sort=` cannot be used for injection.
 */
export function orderBy(spec: SortSpec, fallback: string): string {
  const column = spec.sort && SORTABLE.has(spec.sort) ? spec.sort : fallback;
  const direction = spec.order === 'asc' ? 'ASC' : 'DESC';
  return `${column} ${direction}`;
}

export function pageMeta(total: number, page: number, pageSize: number) {
  return {
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export function offsetOf(page: number, pageSize: number): number {
  return (page - 1) * pageSize;
}
