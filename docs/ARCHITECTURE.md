# Architecture

## The idea in one paragraph

Stock is not stored on the documents that mention it. Every change to a
stock position appends a row to a single `stock_ledger` table, and every figure in
the application — closing balance, available stock, the dashboard, the movement
history — is a query over that table. A purchase, a transfer, an assignment and a
write-off are all just documents; they are not the accounting. The ledger is.

The consequence is that the two figures a signatory is asked to reconcile cannot
disagree, because there is only one of them.

## Shape

```
┌──────────────┐        ┌───────────────────────────────────────┐
│  Browser     │  HTTP  │  Express                              │
│  React SPA   │◀──────▶│  helmet · cors · pino · rate limit    │
│  :5173       │  JSON  │  request context (requestId)          │
└──────────────┘        │  authenticate → authorize → validate   │
                        │  asyncHandler → route → errorHandler  │
                        └───────────────────┬───────────────────┘
                                            │
                    ┌───────────────────────┼────────────────────────┐
                    ▼                       ▼                        ▼
              modules/ (routers)     services/stockService     middleware/audit
              one per bounded area    atomic ledger posting     before/after snapshots
                    │                       │                        │
                    └───────────────────────┴────────────────────────┘
                                            │
                    ┌───────────────────────┼────────────────────────┐
                    ▼                       ▼                        ▼
              SQLite (WAL)          config/rbac.ts           db/audit_logs
              14 tables, 25         one auditable table       every operation,
              indexes, 3 triggers    of who may do what       denials included
```

The frontend is a pure client. It holds no business rules, computes no balances,
and decides nothing about what a user may see beyond hiding controls the API
would reject. Every number it displays came from the API in this request.

## Request lifecycle

Middleware order in `Backend_Army/src/app.ts` is deliberate:

1. **`requestContext`** — mints a `requestId` before anything else, so the id
   appears in the log line, the audit row and the ledger postings for the same
   request. Given `POST /api/transfers/7/receive` request `abc-123`, the receipt
   ledger line, the audit entry and the HTTP log line all read `abc-123`, which is
   what makes a figure traceable end to end.
2. **`helmet`**, **`cors`** — security headers, then an allow-list of origins. A
   request with no `Origin` (curl, health probe) is allowed; a browser origin must
   be listed.
3. **`pino-http`** — one structured JSON line per request, correlated by that same
   `requestId`, with the `Authorization` header redacted.
4. **Body parsers** — JSON and form bodies capped at 256 KB.
5. **Rate limiting** — a general limiter, plus a much tighter one on the
   credential endpoints to blunt password guessing. Both are disabled under
   `NODE_ENV=test` so the suite is not throttled by earlier manual probing.
6. **Route** — `authenticate` → `authorize` → `validate` → `asyncHandler`.

`asyncHandler` exists so a rejected promise in a route reaches the error handler
rather than becoming an unhandled rejection. The error handler is the only place
that formats an error response, which is why every failure in the API has the same
envelope:

```json
{ "error": { "code": "INSUFFICIENT_STOCK", "message": "…", "details": [] },
  "meta": { "requestId": "…" } }
```

`code` is a stable machine-readable string; `message` is written for a person.

## Validation

`validate(schema, source)` takes a Zod schema and a source (`body`, `query`,
`params`). The difference in how the result is applied matters:

- **`body` is replaced** by the parsed output. Zod strips unknown keys, so a client
  cannot smuggle `base_id`, `status` or `created_by` into a request and have a
  controller read a field the client supplied.
- **`query` and `params` are merged** into what is already there, because several
  `validate()` calls stack on one route (pagination, then filters) and replacing
  would let the last call discard the earlier results.

A failure becomes a 422 carrying a field-level list the UI renders inline.

## The accounting model

Two quantities are tracked per `(base, equipment type)`:

- **on-hand** — physically at the base.
- **committed** — on-hand stock that has been issued to a named servicemember and
  is no longer free for anyone else to spend.

From those two:

```
available = on_hand − committed
```

Movements and their effect:

| Transaction | on-hand | committed | Note |
| --- | --- | --- | --- |
| `OPENING_BALANCE` | + | | signed-off starting position |
| `PURCHASE` | + | | goods received |
| `TRANSFER_OUT` | − | | leaves on dispatch, **not** on receipt |
| `TRANSFER_IN` | + | | arrives at the destination |
| `ASSIGNMENT` | 0 | + | moves stock from available to committed |
| `ASSIGNMENT_RETURN` | 0 | − | back to available |
| `EXPENDITURE` | − | − if `source = ASSIGNED` | consumed, so no longer anywhere |

Two decisions are worth stating explicitly, because they are the ones a reviewer
should challenge first:

**A transfer leaves stock on dispatch, not on receipt.** The sending base has
committed the vehicle and the assets; treating them as still present until the far
side confirms would let the same stock be promised to two destinations. The
`TRANSFER_IN` side is a separate, deliberate act by a different role, and that
separation is the accountability the system is for.

**An assignment does not move on-hand.** The asset has not left the base, it has
left the *free pool*. Recording it as an on-hand movement would make the closing
balance look like the base had lost the asset, when the real change is that the
base can no longer issue it twice.

## Why the dashboard refuses to add things up

`GET /api/dashboard/summary` returns `totals_are_meaningful` and `unit`. Summing
1,850 rounds with 7 tyres and 5 vehicles does not produce a quantity — it produces
a number that looks authoritative and means nothing.

So when the request is not scoped to a single equipment type, the API says so
(`unit: "mixed units"`) and the UI says so, rather than presenting a total as if
it were real. The per-equipment and per-base breakdowns exist precisely so the
question can still be answered honestly.

## Frontend

React with TanStack Query and Vite. State that the server owns is not duplicated
in components: queries are keyed, mutations invalidate the affected keys, and
every page derives its figures from a single response.

The permission checks in the UI are a **convenience, not a control**. `can()` reads
the permission list the API returned at sign-in, and hides buttons and routes the
role cannot use. The API enforces the same matrix independently — see
[RBAC.md](RBAC.md) — so hiding is never what makes something safe.

`Permission` is a closed TypeScript union rather than `string`. That is a
deliberate guard: a mistyped permission in a UI check is invisible at runtime, it
simply returns false and quietly hides a control from everyone. Making the type
closed turns that class of bug into a compile error.

## Failure handling

- **Stock rules are enforced in one place.** `assertTransferableStock` and
  `postLedgerEntry` in `services/stockService.ts` are the only code that changes a
  balance, and every document type routes through them inside a transaction. A
  rule duplicated across routers is a rule that will eventually be applied
  inconsistently.
- **Documents are never edited in place.** Purchases, transfers and assignments are
  amended by a new compensating entry. A stored quantity that silently changed
  would make the history a fiction.
- **The ledger cannot be rewritten, even by accident.** `BEFORE UPDATE` and
  `BEFORE DELETE` triggers abort the statement. There is no write endpoint on the
  ledger router at all, and the suite asserts both facts.
- **Denials are recorded.** A request refused by `authorize()` is written to
  `audit_logs` with its status code and outcome `DENIED`, so repeated privilege
  probing is visible rather than invisible. That only works because `audit()` is
  registered *before* `authorize()` in the chain; the reverse order silently loses
  every refusal, which is precisely the attempt worth noticing. Read-only requests
  are not audited — the trail covers operations that change something.

## Testing

The suite is end-to-end over real HTTP against the real app, seeded from the real
seeder — so it exercises the same code path a user does, including validation,
authorization and the audit trail. It is hermetic: a temporary database, an
ephemeral port, cleanup afterwards. See the README for how to run it.

What it deliberately does not do: drive a browser. The React app is verified by
type-checking, a production bundle, and the type system described above — not by
clicking through it. A component or end-to-end browser test would be the next
addition worth making.
