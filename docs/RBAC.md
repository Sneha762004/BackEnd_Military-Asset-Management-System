# Roles and access control

## Model

Access is a permission string, `"<resource>:<action>"`. A role either has one or
does not. Routes declare what they need; the `authorize()` middleware enforces it.

There are no `if (role === 'ADMIN')` checks in controllers. The policy lives in
exactly one auditable table, `Backend_Army/src/config/rbac.ts`, and the same table drives
what the React app renders. A new role is a data change, not a code change.

Three roles:

| Role | Scope | Responsibility |
| --- | --- | --- |
| **System Administrator** | global | Integrity of the system of record: users, audit, every base |
| **Base Commander** | one base | Command accountability: assigns and writes off assets held at their base |
| **Logistics Officer** | one base | Procurement and movement only |

## The matrix

Verified against a running server; the suite re-asserts the load-bearing parts.

| Permission | Admin | Base Commander | Logistics Officer |
| --- | :---: | :---: | :---: |
| `dashboard:read` | ● | ● | ● |
| `base:read` | ● | ● | ● |
| `equipment:read` | ● | ● | ● |
| `purchase:read` | ● | ● | ● |
| `purchase:create` | ● | — | ● |
| `purchase:update` | ● | — | — |
| `purchase:delete` | ● | — | — |
| `transfer:read` | ● | ● | ● |
| `transfer:create` | ● | ● | ● |
| `transfer:update` | ● | ● | — |
| `transfer:approve` | ● | — | — |
| `assignment:read` | ● | ● | — |
| `assignment:create` | ● | ● | — |
| `assignment:update` | ● | ● | — |
| `assignment:delete` | ● | — | — |
| `expenditure:read` | ● | ● | — |
| `expenditure:create` | ● | ● | — |
| `expenditure:delete` | ● | — | — |
| `openingBalance:read` | ● | ● | — |
| `openingBalance:create` | ● | ● | — |
| `openingBalance:update` | ● | — | — |
| `personnel:read` | ● | ● | — |
| `personnel:create` | ● | ● | — |
| `equipment:create` / `:update` | ● | — | — |
| `user:read` / `:create` / `:update` / `:delete` | ● | — | — |
| `audit:read` | ● | — | — |

30 permissions, resolved into the role's list at sign-in and returned in the token
response. The counts: Admin 30, Base Commander 16, Logistics Officer 7.

## What each role sees in the UI

| | Admin | Base Commander | Logistics Officer |
| --- | --- | --- | --- |
| Dashboard, Movement ledger | yes | yes | yes |
| Purchases | list, create, cancel | list | list, create |
| Transfers | list, create, receive, cancel | list, create, receive, cancel | list, create |
| Assignments | full | list, create, return, cancel | — |
| Expenditures | full | list, create | — |
| Users & roles, Audit log | yes | — | — |

The base filter only appears for an Admin. A base-scoped role's dropdown would
offer exactly one option, so it is not rendered.

## Three consequences worth being explicit about

**A Logistics Officer cannot receive a transfer.** They raise it, and a Base
Commander at the destination confirms arrival. Separation of duty, not a missing
feature.

**A Base Commander cannot amend a purchase.** Procurement is a logistics function.
The commander sees purchases for their base because it affects their accountability,
but has no authority to change or reverse one.

**Opening balances are declared by the base, corrected by an administrator.**
`openingBalance:update` is Admin-only. A declared opening position is a
signed-off statement, and letting the same role restate its own starting figure
would defeat the point of recording it.

## Base scoping is a second, independent check

Holding `purchase:read` is not sufficient to read another base's purchases. For
every base-scoped role, `base_id` is forced into each query, and asking for a
different base in the query string is ignored rather than honoured:

```
GET /api/purchases?baseId=2   as cmd.kilo (FWK-01)   →   FWK-01's purchases only
```

The same rule applies to writes. A Logistics Officer naming another base on a
purchase or a transfer is refused with 409, not silently redirected. Redirecting
would leave them believing they had raised a document for their own base when they
had not.

The catalogue cooperates with this: `GET /api/catalogue/bases` returns only the
caller's own base, so the dropdown cannot offer a base they may not act on.

The suite asserts this directly, and asserts the complementary fact that the
sending base cannot confirm receipt of its own transfer.

## Enforcement

`authenticate()` verifies the JWT and loads the live principal — role, base and
active status are re-read on each request, so deactivating an account takes effect
immediately rather than when its token expires. `authorize()` then checks the
declared permission.

Two guards protect against locking the system out:

- an admin cannot change their own role
- an admin cannot deactivate their own account

Both return 409, and both are asserted by the suite.

## In the UI

`can(permission)` reads the permission list from the sign-in response. It hides
routes and buttons the role cannot use.

**This is a convenience, not a control.** The API enforces the same matrix
independently; hiding a button is never what makes an action safe. A user with
`localStorage` access can call any endpoint — and will be refused, and the refusal
of an operation that changes something is recorded in `audit_logs` as `DENIED`
with its status code. Probing for a permission the role does not hold is exactly
the kind of attempt worth being able to see:

```
GET /api/audit-logs?action=PURCHASE_CREATE&statusCode=403
```

`Permission` is a closed TypeScript union, not `string`. A mistyped permission in a
UI check is otherwise invisible: it simply returns false and quietly removes a
control for every user. Making the type closed turns that into a compile error.
