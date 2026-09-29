# MiL-AMS — Military Asset Management System

Movement, assignment and expenditure of critical assets across multiple bases, with
a clear history of every movement and an accounting identity that always reconciles.

```
Net Movement = Purchases + Transfer In − Transfer Out
Closing      = Opening + Net Movement − Expended
Available    = Closing − Assigned
```

Every quantity on screen is derived from one append-only ledger. Nothing is
stored twice, so nothing can drift.

---

## Quick start

Requires **Node 20.11+** (developed on 24.x) and npm 10+.

```bash
npm install                 # installs the server and web workspaces
cp Backend_Army/.env.example Backend_Army/.env
npm run db:reset            # create the schema and load the demo dataset
npm run dev                 # API on :4000, web app on :5173
```

Open <http://localhost:5173> and sign in.

| Account | Role | Base | Password |
| --- | --- | --- | --- |
| `admin` | System Administrator | all | `Admin@12345` |
| `cmd.kilo` | Base Commander | FWK-01 | `Commander@12345` |
| `cmd.meridian` | Base Commander | CMP-02 | `Commander@12345` |
| `cmd.lima` | Base Commander | FOB-04 | `Commander@12345` |
| `log.kilo` | Logistics Officer | FWK-01 | `Logistics@12345` |
| `log.meridian` | Logistics Officer | CMP-02 | `Logistics@12345` |
| `log.warehouse` | Logistics Officer | RWS-03 | `Logistics@12345` |

`SEED_ADMIN_PASSWORD` sets the administrator password at seed time; the other
passwords are fixed in `Backend_Army/src/db/seed.ts`. **Change them before any shared
deployment.**

> The JWT secret in `.env.example` is a development placeholder. Generate a real
> one for anything non-local:
> `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

---

## Scripts

Run from the repository root.

| Command | What it does |
| --- | --- |
| `npm run dev` | API and web app together, both watching |
| `npm run dev:server` / `npm run dev:web` | one of them on its own |
| `npm run build` | type-check and build both workspaces to `dist/` |
| `npm run typecheck` | `tsc --noEmit` across both workspaces |
| `npm test` | 69-assertion end-to-end API smoke suite (see below) |
| `npm run db:reset` | drop, re-migrate and re-seed the database |
| `npm run db:migrate` / `db:seed` | run the two steps separately |
| `npm start` | run the built server from `Backend_Army/dist` |

### The test suite

```bash
npm test
```

The suite is **hermetic**. It migrates and seeds a throwaway SQLite file in the
system temp directory, boots the real Express app on an ephemeral port inside the
test process, and deletes the file afterwards. It writes purchases, transfers,
assignments, expenditures, users and opening balances, so it needs a known
starting state and deliberately does not touch your development database.

Run it repeatedly — the result does not depend on previous runs.

To assert against a server you started yourself instead:

```bash
TEST_BASE_URL=http://127.0.0.1:4000 npm test
```

Coverage: authentication and account-enumeration resistance, the catalogue, the
dashboard identity and its drill-downs, the full purchase/transfer/assignment/
expenditure lifecycle including every refusal path, opening balances, the ledger's
immutability, the audit trail, and the RBAC matrix (each role is required to
succeed on some routes and be refused on others).

---

## Layout

```
Backend_Army/           Express + TypeScript API
  src/config/            environment, RBAC definitions
  src/db/                schema.sql, migrations, deterministic seed
  src/middleware/        auth, authorization, validation, errors, request context
  src/modules/           one router per bounded area
  src/services/          stock posting and reconciliation
  src/smoke.test.ts      end-to-end suite
FrontEnd_Army/          React + TypeScript single-page app
  src/pages/             one component per feature area
  src/components/        shared UI: tables, dialogs, stat cards, icons
  src/context/           session and permissions
docs/                    architecture, database, RBAC and API reference
```

## Documentation

| Document | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the pieces fit, the request lifecycle, and the accounting model |
| [docs/DATABASE.md](docs/DATABASE.md) | Schema, invariants enforced by the database, and the PostgreSQL path |
| [docs/RBAC.md](docs/RBAC.md) | The permission matrix, base scoping, and how enforcement works |
| [docs/API.md](docs/API.md) | Every endpoint, with request and response shapes |

## Configuration

All settings are read once at boot from `Backend_Army/.env`; see
[`.env.example`](Backend_Army/.env.example) for the full annotated list. The ones that
matter most:

| Variable | Default | Notes |
| --- | --- | --- |
| `JWT_SECRET` | dev placeholder | **must** be replaced outside local development |
| `DATABASE_FILE` | `./data/milams.db` | `:memory:` for ephemeral runs |
| `BCRYPT_ROUNDS` | `10` | |
| `RATE_LIMIT_MAX` | `300` | general requests per window, per IP |
| `AUTH_RATE_LIMIT_MAX` | `20` | sign-in attempts per window, per IP |

## Deployment notes

- Serve the built web app (`FrontEnd_Army/dist`) as static files and point it at the API.
- The API serves JSON only and sends no CSP of its own — set a Content-Security-Policy
  at the layer serving the SPA.
- `trust proxy` is enabled automatically when `NODE_ENV=production`, so audit
  entries record the real client address rather than the proxy's.
- See [docs/DATABASE.md](docs/DATABASE.md) before moving off SQLite: the ledger is
  the system of record and its immutability guarantees must survive the migration.
