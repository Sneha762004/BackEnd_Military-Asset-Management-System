# Database

SQLite in WAL mode, accessed through `better-sqlite3`. The schema is a single
declarative file, `Backend_Army/src/db/schema.sql`, applied at boot and by
`npm run db:migrate`. There is no incremental migration chain: one file is the
whole schema, and `--fresh` drops and recreates it.

## Tables

| Table | Purpose |
| --- | --- |
| `roles` | The three roles and their scope; seeded, not user-editable |
| `bases` | Installations. `commander` is a name, not a user reference |
| `users` | Accounts, pinned to a base except for global roles |
| `equipment_types` | Catalogue: code, category, unit, serialised flag |
| `personnel` | Servicemembers who can be issued assets |
| `opening_balances` | A declared position at a period start, one per base/equipment/period |
| `purchases` | Procurement documents |
| `transfers` / `transfer_items` | Inter-base movement; lines on the child |
| `assignments` | Issue of stock to a named servicemember |
| `expenditures` | Write-offs, either direct from base stock or against an assignment |
| `stock_ledger` | **Append-only.** The system of record |
| `audit_logs` | One row per audited operation, with before/after snapshots and any refusal |
| `document_sequences` | Per-year, per-type reference generation |

25 indexes, chosen for the queries that actually run: the dashboard aggregates,
ledger browsing by base/equipment/date, and the document lists filtered by status.

## The ledger

Every row is one movement of one `(base, equipment type)` pair:

```
delta_on_hand      change in on-hand        (signed)
delta_committed    change in committed      (signed)
balance_on_hand    running on-hand after this row, for that pair
effective_date     when the movement counts
request_id         the API call that caused it
actor_id           who did it
```

`balance_on_hand` is denormalized deliberately. It means any figure on the
dashboard can be traced line by line to the movements that produced it, and a
corrupted run is visible as a broken running total rather than as a plausible
wrong number.

## Invariants the database enforces

These are not application conventions. They are refused by SQLite itself, so they
hold no matter which code path attempts the write.

**The ledger is immutable.**

```sql
CREATE TRIGGER trg_stock_ledger_immutable_update BEFORE UPDATE ON stock_ledger …
CREATE TRIGGER trg_stock_ledger_immutable_delete BEFORE DELETE ON stock_ledger …
```

Both `RAISE(ABORT)`. There is no `UPDATE` or `DELETE` in the service layer, no
write endpoint on the ledger router, and the suite asserts all three. Correcting a
posting means appending a reversing entry, which is the behaviour an accountability
system needs anyway.

**An assigned expenditure must reference a live assignment.**

```sql
CREATE TRIGGER trg_expenditure_assignment_consistency BEFORE INSERT ON expenditures
  WHEN NEW.source = 'ASSIGNED' …
```

It rejects an `ASSIGNED` write-off with no `assignment_id`, with an assignment from
a different base or equipment type, or against an assignment that is already
`CANCELLED` or `RETURNED`. The trigger guards the *expenditure row*; keeping the
assignment document's own counters in step is the application layer's job, done in
the same transaction (see below).

**Check constraints keep documents internally sane.** Non-negative quantities and
costs, `quantity_returned + quantity_expended <= quantity` on an assignment,
`delta_on_hand` and `delta_committed` non-zero, dates in order, statuses drawn from
a fixed list, and a uniqueness rule per `(base, equipment type, period)` on opening
balances. `PRAGMA foreign_keys = ON` — SQLite ignores foreign keys by default, and
without this pragma the references are decorative.

## Keeping a document and the ledger in step

The recurring hazard in this schema is that a document and the ledger can each be
correct in isolation and still disagree — for example, an expenditure that
correctly releases committed stock in the ledger while the assignment document
still reports those units as outstanding to the servicemember. Any figure derived
from documents would then contradict one derived from the ledger.

Both writers handle this inside their transaction:

- `POST /api/expenditures` increments `assignments.quantity_expended` and
  recomputes the status.
- The seeder's `raiseExpenditure` does the same, so the demo dataset is
  internally consistent rather than merely plausible.

`npm test` finishes by re-asserting the accounting identity over the whole run, and
the demo data was checked for the same agreement across every base/equipment
position. The two "assigned" totals on the dashboard are computed from the ledger;
the per-assignment figures come from the documents, and they reconcile.

## Connection settings

```ts
db.pragma('journal_mode = WAL');   // readers proceed during a write transaction
db.pragma('foreign_keys = ON');    // off by default in SQLite
db.pragma('synchronous = NORMAL'); // durable enough with WAL, much faster
db.pragma('busy_timeout = 5000');  // wait rather than throw SQLITE_BUSY
```

WAL is the reason a single file is enough for a real workload here: report queries
read while a movement is being posted. A transaction is all-or-nothing via
`inTransaction()`, so a document and its ledger lines are committed together or not
at all.

## The demo dataset

`npm run db:seed` loads 4 bases, 8 equipment types, 9 personnel, 7 accounts, and
enough purchases, transfers, assignments, expenditures and opening balances to make
every dashboard figure interesting. It is deterministic and uses the real service
layer and the real reference generator, so seeded balances are produced the same
way live ones are — there is no second, weaker code path that could make the demo
data look better than reality.

## Moving to PostgreSQL

SQLite is the right choice for a single-node deployment: no service to operate, one
file to back up, and transactions that are genuinely atomic. PostgreSQL is the right
choice once several application instances must write concurrently, or when the
dataset outgrows one machine's write throughput.

The migration is mostly mechanical, but two things must be preserved deliberately:

**Immutability must not silently weaken.** SQLite's triggers become PostgreSQL
triggers, or a rule plus a `REVOKE`:

```sql
CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stock_ledger is append-only';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_no_update BEFORE UPDATE ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
```

**`balance_on_hand` becomes an explicit invariant.** SQLite recomputes it in the
same statement that inserts the row. In PostgreSQL, compute it inside the posting
transaction with `SELECT … FOR UPDATE` on the `(base_id, equipment_type_id)`
position, or maintain it with a window function. It must stay a running total per
pair, because that is what makes the trace work.

The application changes are limited to `db/connection.ts` and the few helpers in
`db/` and `services/stockService.ts`; the schema, the routers and the RBAC layer
are ordinary SQL and port unchanged. The suite is the acceptance test for the
migration: point it at the PostgreSQL-backed server with `TEST_BASE_URL` and all
69 assertions should pass unchanged.
