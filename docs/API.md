# API reference

Base URL `http://localhost:4000` in development. All responses are JSON.

## Conventions

**Success** — resource or collection, with pagination where relevant:

```json
{ "data": { "id": 7, "reference": "TRF-2026-0007" },
  "meta": { "requestId": "…" } }
```

**Collection** — `data` is an array and `meta` carries paging plus, for report
listings, a `summary` computed over the *whole filtered set*, not the current page:

```json
{ "data": [ … ],
  "meta": { "total": 34, "page": 1, "pageSize": 25, "pageCount": 2,
            "summary": { "in_transit": 2, "completed": 5, "drafts": 0, "units_in_transit": 10 } } }
```

**Failure** — one shape, always:

```json
{ "error": { "code": "INSUFFICIENT_STOCK",
             "message": "Only 3 unit(s) available at FWK-01 for Rifle 5.56mm.",
             "details": [] },
  "meta": { "requestId": "…" } }
```

`code` is stable and machine-readable; `message` is written for a person. Validation
failures are 422 and carry a field-level list in `details`:

```json
"details": [ { "path": "receivedDate", "code": "custom", "message": "Received date cannot precede the purchase date" } ]
```

Common codes: `UNAUTHENTICATED` 401 · `FORBIDDEN` 403 · `NOT_FOUND` 404 ·
`CONFLICT` 409 · `INSUFFICIENT_STOCK` 409 · `VALIDATION_FAILED` 422 ·
`INVALID_STATE_TRANSITION` 409 · `RATE_LIMITED` 429.

Every response carries `X-Request-Id`, and it appears in the audit trail and in the
ledger rows the request produced.

**Authentication** — `Authorization: Bearer <token>` on everything except
`GET /health` and `POST /api/auth/login`.

**Pagination** — `?page=1&pageSize=25` (max 200), plus `sort` and `order=asc|desc`.

**Filtering** — report listings accept `dateFrom`, `dateTo` (ISO `YYYY-MM-DD`),
`baseId`, `equipmentTypeId`, `category`, `status`, `search`. A base-scoped role is
pinned to its own base regardless of what it asks for. The audit trail additionally
accepts `actor`, `action`, `entityType`, `outcome`, `statusCode`.

---

## Health

### `GET /health`

Public. Liveness probe.

```json
{ "data": { "status": "ok", "service": "milams-api", "env": "development", "time": "…" } }
```

Note this path is **not** under `/api`.

---

## Authentication

| Method | Path | Permission |
| --- | --- | --- |
| `POST` | `/api/auth/login` | — |
| `GET` | `/api/auth/me` | authenticated |
| `POST` | `/api/auth/change-password` | authenticated |
| `GET` | `/api/auth/roles` | authenticated |

### `POST /api/auth/login`

```json
{ "username": "admin", "password": "Admin@12345" }
```

```json
{ "data": { "token": "eyJ…",
  "user": { "id": 1, "username": "admin", "fullName": "System Administrator",
            "rank": "CIV (Grade A)", "role": "ADMIN",
            "permissions": ["dashboard:read", "…"], "baseId": null,
            "baseCode": null, "baseName": null } } }
```

A wrong password and an unknown username both return the same 401
`INVALID_CREDENTIALS`, so the endpoint cannot be used to enumerate accounts.

Tokens expire after 8 hours by default. `GET /api/auth/me` re-reads the live
principal, so a deactivated account loses access before its token expires.

### `GET /api/auth/roles`

The role catalogue, minus internal detail — drives the role dropdown in user
administration.

```json
{ "data": [ { "key": "BASE_COMMANDER", "name": "Base Commander", "description": "…",
              "scope": "BASE", "permissions": ["…"] } ] }
```

---

## Catalogue

Read endpoints are available to every authenticated role; writes are Admin-only.

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/api/catalogue/bases` | `base:read` |
| `POST` | `/api/catalogue/bases` | `base:create` |
| `GET` | `/api/catalogue/equipment` | `equipment:read` |
| `POST` | `/api/catalogue/equipment` | `equipment:create` |
| `GET` | `/api/catalogue/personnel` | `personnel:read` |
| `POST` | `/api/catalogue/personnel` | `personnel:create` |

`GET /api/catalogue/bases` returns only the caller's own base for a base-scoped
role. `GET /api/catalogue/equipment` returns `id, code, name, category, unit,
serialised, description, is_active`. `GET /api/catalogue/personnel` returns `id,
service_number, full_name, rank, unit, base_id, base_code, base_name, is_active`.

---

## Dashboard

All six require `dashboard:read` and accept the standard report filters.

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/dashboard/summary` | KPIs, document counts, scope |
| `GET` | `/api/dashboard/net-movement` | the net movement with its component breakdown |
| `GET` | `/api/dashboard/by-equipment` | per-equipment walk-down |
| `GET` | `/api/dashboard/by-base` | per-base walk-down |
| `GET` | `/api/dashboard/trend` | 6-point daily series |
| `GET` | `/api/dashboard/movements` | paged movement feed |

### `GET /api/dashboard/summary`

```json
{ "data": {
  "scope": { "role": "ADMIN", "baseId": null, "baseLabel": "All bases" },
  "totals": {
    "opening_balance": 33, "purchases": 104044,
    "transfer_in": 13028, "transfer_out": 13038, "expended": 17110,
    "assigned": 11, "closing_balance": 86957, "net_movement": 104034,
    "available": 86946,
    "totals_are_meaningful": false, "unit": "mixed units" },
  "document_counts": { "purchases": { "n": 7 },
                       "transfers": { "documents": 2, "units": 10 },
                       "assignments": { "documents": 8, "units": 12 },
                       "expenditures": { "n": 10 } } } }
```

`closing_balance = opening_balance + (purchases + transfer_in − transfer_out) − expended`
and `available = closing_balance − assigned`. The suite asserts both.

`totals_are_meaningful` is **false** when the request spans more than one equipment
type: summing rounds with tyres is not a quantity. Clients should say so rather than
present the total — the per-equipment and per-base endpoints exist to answer the
question properly. Scoped to a single `equipmentTypeId`, the flag is true and
`unit` names the real unit (`"rounds"`, `"weapons"`, …).

### `GET /api/dashboard/net-movement`

The headline figure, decomposed — so the number on the dashboard can be checked
rather than trusted.

```json
{ "data": { "purchases": 104044, "transfer_in": 13028, "transfer_out": 13038,
            "net_movement": 104034, "formula": "purchases + transfer_in − transfer_out" } }
```

### `GET /api/dashboard/movements`

Paged feed of ledger lines with their document reference, actor and running
balance. The `requestId` of each is a link into the audit trail.

---

## Purchases

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/api/purchases` | `purchase:read` |
| `GET` | `/api/purchases/:id` | `purchase:read` |
| `POST` | `/api/purchases` | `purchase:create` |
| `PATCH` | `/api/purchases/:id` | `purchase:update` |
| `POST` | `/api/purchases/:id/cancel` | `purchase:update` |

### `POST /api/purchases`

```json
{ "baseId": 1, "equipmentTypeId": 1, "quantity": 5, "unitCost": 120000,
  "supplier": "…", "contractRef": "…",
  "purchaseDate": "2026-09-27", "receivedDate": "2026-09-27", "notes": "" }
```

`baseId` is optional and filled from the caller's base for a base-scoped role;
naming a different base is refused with 409. `receivedDate` before `purchaseDate`
is 422.

Creates the document and posts its `PURCHASE` ledger line in one transaction, so
stock is never visible without the document that explains it.

`meta.summary` on the list: `document_count`, `total_quantity`, `total_value`
(received documents only).

### `POST /api/purchases/:id/cancel`

```json
{ "reason": "Duplicate order" }
```

Posts a reversing entry. The body is **required** — a cancellation is an audited
decision and is recorded with a reason. Cancelling twice is 409.

---

## Transfers

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/api/transfers` | `transfer:read` |
| `GET` | `/api/transfers/:id` | `transfer:read` |
| `POST` | `/api/transfers` | `transfer:create` |
| `POST` | `/api/transfers/:id/receive` | `transfer:update` |
| `POST` | `/api/transfers/:id/cancel` | `transfer:update` |

### `POST /api/transfers`

```json
{ "fromBaseId": 1, "toBaseId": 3, "transferDate": "2026-09-27",
  "vehicleRef": "…", "notes": "",
  "items": [ { "equipmentTypeId": 1, "quantity": 40 } ] }
```

`fromBaseId` is **optional**: a base-scoped role always transfers out of its own
base, and the server fills it in from the token so the client need not know its base
id. An Admin must supply it. `toBaseId` may not equal `fromBaseId` (409).

Refused with 409 `INSUFFICIENT_STOCK` if the source cannot cover a line, and if any
line includes stock already issued to personnel — committed stock is not
transferable.

Stock leaves the source **at dispatch** and arrives **on receipt**. Both legs carry
the same reference, so the movement history reads as one journey. `GET
/api/transfers/:id` returns the `items` array with `quantity_received` per line.

### `POST /api/transfers/:id/receive`

```json
{ "notes": "Received intact" }
```

Posts `TRANSFER_IN` at the destination. The sending base cannot confirm its own
receipt, and a second receipt is refused as an invalid transition.

`meta.summary` on the list: `in_transit`, `completed`, `drafts`, `units_in_transit`.

---

## Assignments

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/api/assignments` | `assignment:read` |
| `GET` | `/api/assignments/:id` | `assignment:read` |
| `POST` | `/api/assignments` | `assignment:create` |
| `POST` | `/api/assignments/:id/return` | `assignment:update` |
| `POST` | `/api/assignments/:id/cancel` | `assignment:delete` |

### `POST /api/assignments`

```json
{ "baseId": 1, "equipmentTypeId": 1, "personnelId": 3, "quantity": 2,
  "assignedDate": "2026-09-27", "dueDate": "2026-10-27", "purpose": "…", "notes": "" }
```

On-hand is **unchanged**: the base still holds the asset and stays accountable for
it. `committed` rises, so it stops being available for anything else — the suite
asserts that committed stock cannot then be transferred away.

Statuses: `ACTIVE`, `PARTIALLY_RETURNED`, `RETURNED`, `EXPENDED`, `CANCELLED`.

### `POST /api/assignments/:id/return`

```json
{ "quantity": 1, "date": "2026-10-01", "notes": "" }
```

Returning more than is outstanding is refused. Returning the balance closes the
assignment as `RETURNED`. `POST /api/assignments/:id/cancel` reverses the whole
issue and makes the units available again.

`meta.summary` on the list: `document_count`, `units_issued`, `units_outstanding`,
`active_count`.

---

## Expenditures

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/api/expenditures` | `expenditure:read` |
| `GET` | `/api/expenditures/:id` | `expenditure:read` |
| `POST` | `/api/expenditures` | `expenditure:create` |
| `GET` | `/api/expenditures/meta/reasons` | `expenditure:read` |

### `POST /api/expenditures`

```json
{ "baseId": 1, "equipmentTypeId": 1, "quantity": 20,
  "source": "ASSIGNED", "assignmentId": 3,
  "reason": "COMBAT", "expendedDate": "2026-09-27",
  "authorisedBy": "Col. R. Adeyemi", "notes": "" }
```

The only operation that permanently reduces on-hand stock, so the dashboard's
closing balance depends on it. Two paths:

- `source: "DIRECT"` — written off from base stock, never issued.
- `source: "ASSIGNED"` — consumed under an open assignment. Requires `assignmentId`;
  reduces on-hand **and** committed, and increments the assignment's
  `quantity_expended` in the same transaction, so the document and the ledger stay
  in step. The assignment must be open, and for the same base and equipment type.

`reason` is one of `COMBAT`, `TRAINING`, `MAINTENANCE`, `LOSS`, `DAMAGE`,
`DECOMMISSIONED`, `OTHER`. Writing off more than is held is refused.

`meta.summary` on the list: `document_count`, `units_written_off`.

---

## Opening balances

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/api/opening-balances` | `openingBalance:read` |
| `POST` | `/api/opening-balances` | `openingBalance:create` |
| `GET` | `/api/opening-balances/next-period` | `openingBalance:read` |
| `PATCH` | `/api/opening-balances/:id` | `openingBalance:update` |

### `POST /api/opening-balances`

```json
{ "baseId": 1, "equipmentTypeId": 1, "quantity": 500,
  "periodStart": "2026-10-01", "notes": "" }
```

A declared, signed-off position at a period start — not a computed figure. It posts
an `OPENING_BALANCE` ledger line so every later closing balance reconciles back to
it. `periodStart` is normalised to the 1st of the month; it defaults to the current
month. One record per `(base, equipment type, period)` — a second is 409.

`GET /api/opening-balances/next-period` returns the first day of the following month,
for the create form.

---

## Ledger

Read-only. There is no write endpoint, and the table refuses `UPDATE` and `DELETE`
at the database level.

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/api/ledger` | `dashboard:read` |
| `GET` | `/api/ledger/balances` | `dashboard:read` |

### `GET /api/ledger`

Every movement, newest first. Accepts `direction` (`IN`/`OUT`), `txnType`,
`refType`, `refId` in addition to the standard filters.

```json
{ "data": [ { "id": 412, "base_code": "FWK-01", "equipment_code": "EQ-WPN-556",
              "txn_type": "ASSIGNMENT", "ref_type": "ASSIGNMENT", "ref_id": 3,
              "ref_reference": "ASN-2026-0003", "quantity": 1, "direction": "IN",
              "delta_on_hand": 0, "delta_committed": 1, "balance_on_hand": 180,
              "effective_date": "2026-09-22", "actor_username": "cmd.kilo",
              "request_id": "…" } ],
  "meta": { "total": 412, "page": 1, "pageSize": 25, "pageCount": 17,
            "summary": { "inbound": 117072, "outbound": 30098, "net": 86974 } } }
```

`summary` is computed over the whole filtered set, so the net change is correct
regardless of which page is being viewed.

### `GET /api/ledger/balances`

Current position per `(base, equipment type)`: `on_hand`, `committed`, `available`,
`last_movement_date`. Accepts `baseId`, `equipmentTypeId` and `category`.

---

## User administration

Admin-only. `GET` and `POST /api/admin/users`, `PATCH` and `DELETE
/api/admin/users/:id`; every one is refused with 403 for a base-scoped role.

```json
// POST
{ "username": "log.meridian", "email": "log.meridian@milams.example",
  "fullName": "2/Lt. P. Larsen", "rank": "Second Lieutenant",
  "role": "LOGISTICS_OFFICER", "baseId": 2, "password": "…" }
```

A base-scoped role requires a `baseId` and a global role must not have one — both
mismatches are 409. An admin cannot change their own role or deactivate their own
account (409, self-lockout guard).

---

## Audit trail

Admin-only (`audit:read`); every other role receives 403.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/audit-logs` | Paged, filterable |
| `GET` | `/api/audit-logs/summary` | Daily activity counts, last 30 days |
| `GET` | `/api/audit-logs/:requestId` | Every call and posting for one request |

```json
{ "data": [ { "id": 88, "request_id": "b21f…", "actor_username": "log.kilo",
              "actor_role": "LOGISTICS_OFFICER", "action": "TRANSFER_CREATE",
              "entity_type": "transfer", "entity_id": "6", "method": "POST",
              "path": "/api/transfers", "status_code": 201, "outcome": "SUCCESS",
              "message": "", "duration_ms": 14,
              "created_at": "2026-09-27T17:47:06.596Z" } ],
  "meta": { "total": 88, "page": 1, "pageSize": 50, "pageCount": 2,
            "actions": [ { "value": "PURCHASE_CREATE", "count": 7 } ] } }
```

Auditing is **opt-in per route**, and it covers the state-changing operations —
the ones that move stock, money or authority — plus sign-in. Read-only list and
report requests are deliberately not recorded, which is what keeps the table
readable and keeps a report page from writing a row per click.

For an audited route the row is written when the response completes, so it
carries the real status code:

| Status | `outcome` | Meaning |
| --- | --- | --- |
| 2xx / 3xx | `SUCCESS` | the operation took effect |
| 401 / 403 | `DENIED` | the caller was not permitted — **recorded** |
| other 4xx | `FAILURE` | refused: 409 conflict, 422 validation, 404 |
| 5xx | `FAILURE` | the request failed server-side |

`DENIED` is a privilege decision, distinct from a business conflict. Only a 2xx is
ever `SUCCESS`, so the field cannot flatter a rejected request.

A denial is captured because the `audit()` middleware is registered *before*
`authorize()` in each chain: it only attaches a listener, so a request that
`authorize()` turns away still produces a row, naming the operation attempted and
the officer who tried. Repeated privilege probing is therefore visible, e.g.

```
GET /api/audit-logs?action=PURCHASE_CREATE&statusCode=403
```

returns the officer's refused attempts. `action` names the business operation
(`PURCHASE_CREATE`, `TRANSFER_RECEIVE`, `AUTH_LOGIN`, …). Entity changes carry a
before/after snapshot.

`GET /api/audit-logs/:requestId` is the join: give it the `requestId` from a
response header and it returns every call and every ledger posting from that one
request.
