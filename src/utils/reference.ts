import type { Database } from 'better-sqlite3';

/** Document families that carry a printed reference number. */
export const DOC_TYPES = {
  PURCHASE: { prefix: 'PO', table: 'purchases', column: 'reference' },
  TRANSFER: { prefix: 'TRF', table: 'transfers', column: 'reference' },
  ASSIGNMENT: { prefix: 'ASN', table: 'assignments', column: 'reference' },
  EXPENDITURE: { prefix: 'EXP', table: 'expenditures', column: 'reference' },
} as const;

export type DocType = keyof typeof DOC_TYPES;

/**
 * Atomically reserve the next document number, e.g. `PO-2026-0042`.
 *
 * Must be called inside the same transaction that inserts the document so the
 * reservation rolls back with the write. `period` is derived from the supplied
 * date (not "today"), so a back-dated document still gets a reference from the
 * period it belongs to.
 */
export function nextReference(db: Database, docType: DocType, date: string): string {
  const def = DOC_TYPES[docType];
  const period = date.slice(0, 4);

  db.prepare(
    `INSERT INTO document_sequences (doc_type, period, next_val)
     VALUES (?, ?, 1)
     ON CONFLICT (doc_type, period) DO UPDATE SET next_val = next_val + 1`,
  ).run(docType, period);

  const row = db
    .prepare(`SELECT next_val FROM document_sequences WHERE doc_type = ? AND period = ?`)
    .get(docType, period) as { next_val: number } | undefined;

  if (!row) throw new Error(`Failed to reserve a ${def.prefix} reference number`);

  return `${def.prefix}-${period}-${String(row.next_val).padStart(4, '0')}`;
}
