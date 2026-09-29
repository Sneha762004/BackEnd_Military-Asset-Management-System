-- =============================================================================
-- Military Asset Management System (MiL-AMS)
-- Relational schema - SQLite dialect (ANSI-leaning; see docs/DATABASE.md for the
-- PostgreSQL migration notes, the differences are called out inline).
--
-- DESIGN PRINCIPLES
--   1. Every asset movement is a business document (purchase / transfer /
--      assignment / expenditure) with a human-readable reference number.
--   2. Every movement is *also* written to `stock_ledger` - an append-only
--      signed running balance per (base, equipment_type). The ledger is the
--      single source of truth for "how many do we hold and why".
--   3. Opening balances are an *explicit, auditable record* per accounting
--      period - not a computed guess. That is what makes Closing Balance
--      trustworthy and reconcilable.
--   4. Foreign keys, CHECK constraints and UNIQUE keys do the integrity work
--      in the database, not only in application code.
--   5. Nothing that represents an asset transaction is ever UPDATEd or DELETEd
--      (only status columns change). Corrections are made with reversing
--      documents so the audit trail stays complete.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- Reference / security
-- -----------------------------------------------------------------------------

-- Roles are table-driven so they can be extended without a code change, but the
-- application treats these three keys as canonical (see src/config/rbac.ts).
CREATE TABLE IF NOT EXISTS roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT    NOT NULL UNIQUE,           -- ADMIN | BASE_COMMANDER | LOGISTICS_OFFICER
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  -- Coarse grouping used for UI navigation filtering.
  scope       TEXT    NOT NULL DEFAULT 'GLOBAL'
              CHECK (scope IN ('GLOBAL', 'BASE'))
);

-- Physical installations that hold stock.
CREATE TABLE IF NOT EXISTS bases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL UNIQUE,             -- e.g. FWK-01
  name       TEXT    NOT NULL,
  location   TEXT    NOT NULL DEFAULT '',
  country    TEXT    NOT NULL DEFAULT '',
  commander  TEXT    NOT NULL DEFAULT '',
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A LOGISTICS_OFFICER or BASE_COMMANDER is pinned to exactly one base.
-- NULL means "sees every base" and is only allowed for GLOBAL-scope roles.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  full_name     TEXT    NOT NULL,
  rank          TEXT    NOT NULL DEFAULT '',
  password_hash TEXT    NOT NULL,
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  base_id       INTEGER REFERENCES bases(id) ON DELETE RESTRICT,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  last_login_at TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);
CREATE INDEX IF NOT EXISTS idx_users_base ON users(base_id);

-- -----------------------------------------------------------------------------
-- Catalogue
-- -----------------------------------------------------------------------------

-- Equipment types (classes of assets), e.g. "Rifle 5.56mm", "HMMWV", "7.62mm ammo".
-- Asset *instances* (serials) are intentionally out of scope for v1 - the system
-- manages bulk quantities, which is what the reporting requirements ask for. The
-- `serialised` flag reserves the design slot for future serial-level tracking.
CREATE TABLE IF NOT EXISTS equipment_types (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,            -- e.g. EQ-WPN-556
  name        TEXT    NOT NULL,
  category    TEXT    NOT NULL
              CHECK (category IN ('WEAPON', 'VEHICLE', 'AMMUNITION', 'EQUIPMENT', 'SPARES', 'FUEL')),
  unit        TEXT    NOT NULL DEFAULT 'unit',   -- unit / rounds / litres ...
  serialised  INTEGER NOT NULL DEFAULT 0 CHECK (serialised IN (0, 1)),
  description TEXT    NOT NULL DEFAULT '',
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_equipment_category ON equipment_types(category);

-- Serving personnel. Assignments point here so that "who holds what" is a real
-- relationship rather than free text.
CREATE TABLE IF NOT EXISTS personnel (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  service_number TEXT    NOT NULL UNIQUE,
  full_name      TEXT    NOT NULL,
  rank           TEXT    NOT NULL DEFAULT '',
  unit           TEXT    NOT NULL DEFAULT '',
  base_id        INTEGER NOT NULL REFERENCES bases(id) ON DELETE RESTRICT,
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_personnel_base ON personnel(base_id);

-- -----------------------------------------------------------------------------
-- Opening balances
-- -----------------------------------------------------------------------------

-- The signed-off stock position at the start of a period, per base and per
-- equipment type. Recording it explicitly (rather than deriving it) is what lets
-- the system prove that Closing = Opening + Purchases + In - Out - Expended
-- for any historical period, even if documents were migrated in.
CREATE TABLE IF NOT EXISTS opening_balances (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  base_id           INTEGER NOT NULL REFERENCES bases(id) ON DELETE RESTRICT,
  equipment_type_id INTEGER NOT NULL REFERENCES equipment_types(id) ON DELETE RESTRICT,
  period_start      TEXT    NOT NULL,            -- ISO date, always the 1st of the month
  quantity          INTEGER NOT NULL CHECK (quantity >= 0),
  recorded_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes             TEXT    NOT NULL DEFAULT '',
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (base_id, equipment_type_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_opening_period ON opening_balances(period_start);

-- -----------------------------------------------------------------------------
-- Purchases
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS purchases (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  reference         TEXT    NOT NULL UNIQUE,      -- e.g. PO-2026-0001
  base_id           INTEGER NOT NULL REFERENCES bases(id) ON DELETE RESTRICT,
  equipment_type_id INTEGER NOT NULL REFERENCES equipment_types(id) ON DELETE RESTRICT,
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost         INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),  -- minor units
  supplier          TEXT    NOT NULL DEFAULT '',
  contract_ref      TEXT    NOT NULL DEFAULT '',
  purchase_date     TEXT    NOT NULL,            -- ISO date (may be in the past)
  received_date     TEXT    NOT NULL,            -- ISO date - drives the ledger
  status            TEXT    NOT NULL DEFAULT 'RECEIVED'
                    CHECK (status IN ('DRAFT', 'RECEIVED', 'CANCELLED')),
  notes             TEXT    NOT NULL DEFAULT '',
  created_by        INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  cancelled_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at      TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_purchases_base_date ON purchases(base_id, received_date);
CREATE INDEX IF NOT EXISTS idx_purchases_equipment_date ON purchases(equipment_type_id, received_date);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);

-- -----------------------------------------------------------------------------
-- Transfers (header + lines)
-- -----------------------------------------------------------------------------

-- A transfer is a single movement instruction that may carry several equipment
-- types. Lines allow one document to be referenced in the movement history.
CREATE TABLE IF NOT EXISTS transfers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  reference     TEXT    NOT NULL UNIQUE,          -- e.g. TRF-2026-0001
  from_base_id  INTEGER NOT NULL REFERENCES bases(id) ON DELETE RESTRICT,
  to_base_id    INTEGER NOT NULL REFERENCES bases(id) ON DELETE RESTRICT,
  status        TEXT    NOT NULL DEFAULT 'IN_TRANSIT'
                CHECK (status IN ('DRAFT', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED')),
  transfer_date TEXT    NOT NULL,                -- ISO date raised
  received_date TEXT,                            -- ISO date received at destination
  dispatched_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  received_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  vehicle_ref   TEXT    NOT NULL DEFAULT '',    -- convoy / carrier reference
  notes         TEXT    NOT NULL DEFAULT '',
  created_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  cancelled_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at  TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (from_base_id <> to_base_id)             -- a base cannot transfer to itself
);

CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_base_id, transfer_date);
CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(to_base_id, transfer_date);
CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status);

CREATE TABLE IF NOT EXISTS transfer_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id       INTEGER NOT NULL REFERENCES transfers(id) ON DELETE RESTRICT,
  equipment_type_id INTEGER NOT NULL REFERENCES equipment_types(id) ON DELETE RESTRICT,
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  quantity_received INTEGER CHECK (quantity_received IS NULL OR quantity_received >= 0),
  UNIQUE (transfer_id, equipment_type_id)
);

CREATE INDEX IF NOT EXISTS idx_transfer_items_transfer ON transfer_items(transfer_id);

-- -----------------------------------------------------------------------------
-- Assignments
-- -----------------------------------------------------------------------------

-- Lifecycle: ACTIVE -> RETURNED (full/partial) or -> EXPENDED (via expenditure).
-- An assignment does NOT reduce on-hand stock: the asset is still held by the
-- base and remains the base's liability until it is expended or returned. It is
-- reported separately as "committed / issued" (see docs/DATABASE.md).
CREATE TABLE IF NOT EXISTS assignments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  reference         TEXT    NOT NULL UNIQUE,      -- e.g. ASN-2026-0001
  base_id           INTEGER NOT NULL REFERENCES bases(id) ON DELETE RESTRICT,
  equipment_type_id INTEGER NOT NULL REFERENCES equipment_types(id) ON DELETE RESTRICT,
  personnel_id      INTEGER NOT NULL REFERENCES personnel(id) ON DELETE RESTRICT,
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  quantity_returned INTEGER NOT NULL DEFAULT 0 CHECK (quantity_returned >= 0),
  quantity_expended INTEGER NOT NULL DEFAULT 0 CHECK (quantity_expended >= 0),
  status            TEXT    NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE', 'PARTIALLY_RETURNED', 'RETURNED', 'EXPENDED', 'CANCELLED')),
  assigned_date     TEXT    NOT NULL,
  due_date          TEXT,
  returned_date     TEXT,
  purpose           TEXT    NOT NULL DEFAULT '',
  notes             TEXT    NOT NULL DEFAULT '',
  created_by        INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  cancelled_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at      TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- An assignment can never be over-consumed by returns + expenditure.
  CHECK (quantity_returned + quantity_expended <= quantity)
);

CREATE INDEX IF NOT EXISTS idx_assignments_base ON assignments(base_id, assigned_date);
CREATE INDEX IF NOT EXISTS idx_assignments_personnel ON assignments(personnel_id, status);
CREATE INDEX IF NOT EXISTS idx_assignments_status ON assignments(status);

-- -----------------------------------------------------------------------------
-- Expenditures
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS expenditures (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  reference         TEXT    NOT NULL UNIQUE,      -- e.g. EXP-2026-0001
  base_id           INTEGER NOT NULL REFERENCES bases(id) ON DELETE RESTRICT,
  equipment_type_id INTEGER NOT NULL REFERENCES equipment_types(id) ON DELETE RESTRICT,
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  -- DIRECT  = written off straight from base stock (never issued)
  -- ASSIGNED= consumed by a servicemember under an open assignment
  source            TEXT    NOT NULL DEFAULT 'DIRECT'
                    CHECK (source IN ('DIRECT', 'ASSIGNED')),
  assignment_id     INTEGER REFERENCES assignments(id) ON DELETE RESTRICT,
  reason            TEXT    NOT NULL
                    CHECK (reason IN ('COMBAT', 'TRAINING', 'MAINTENANCE', 'LOSS', 'DAMAGE', 'DECOMMISSIONED', 'OTHER')),
  expended_date     TEXT    NOT NULL,
  authorised_by     TEXT    NOT NULL DEFAULT '',
  notes             TEXT    NOT NULL DEFAULT '',
  created_by        INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_expenditures_base ON expenditures(base_id, expended_date);
CREATE INDEX IF NOT EXISTS idx_expenditures_equipment_date ON expenditures(equipment_type_id, expended_date);
CREATE INDEX IF NOT EXISTS idx_expenditures_assignment ON expenditures(assignment_id);

-- Enforce that an ASSIGNED expenditure really points at an open assignment from
-- the same base and equipment type.
CREATE TRIGGER IF NOT EXISTS trg_expenditure_assignment_consistency
BEFORE INSERT ON expenditures
FOR EACH ROW WHEN NEW.source = 'ASSIGNED'
BEGIN
  SELECT RAISE(ABORT, 'expenditure.assignment_id is required when source = ASSIGNED')
  WHERE NEW.assignment_id IS NULL;

  SELECT RAISE(ABORT, 'expenditure assignment must belong to the same base and equipment type')
  WHERE NOT EXISTS (
    SELECT 1 FROM assignments a
    WHERE a.id = NEW.assignment_id
      AND a.base_id = NEW.base_id
      AND a.equipment_type_id = NEW.equipment_type_id
      AND a.status NOT IN ('CANCELLED', 'RETURNED')
  );
END;

-- -----------------------------------------------------------------------------
-- Stock ledger (append-only)
-- -----------------------------------------------------------------------------

-- One row per (base, equipment_type) movement. `balance_after` is the running
-- on-hand quantity for that pair at the moment of the movement - so any figure
-- on the dashboard can be traced back, line by line, to its causes.
--
-- txn_type values and their effect on on-hand:
--   OPENING_BALANCE  +   recorded opening position
--   PURCHASE         +   goods received
--   TRANSFER_IN      +   received from another base
--   TRANSFER_OUT     -   dispatched to another base
--   ASSIGNMENT       +-   0 on-hand movement; flagged as committed (delta_committed)
--   RETURN           +-   0 on-hand movement; released committed stock
--   EXPENDITURE      -   written off / consumed
CREATE TABLE IF NOT EXISTS stock_ledger (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  base_id           INTEGER NOT NULL REFERENCES bases(id) ON DELETE RESTRICT,
  equipment_type_id INTEGER NOT NULL REFERENCES equipment_types(id) ON DELETE RESTRICT,
  txn_type          TEXT    NOT NULL
                    CHECK (txn_type IN ('OPENING_BALANCE', 'PURCHASE', 'TRANSFER_IN', 'TRANSFER_OUT',
                                        'ASSIGNMENT', 'RETURN', 'EXPENDITURE', 'ADJUSTMENT')),
  ref_type          TEXT    NOT NULL
                    CHECK (ref_type IN ('OPENING_BALANCE', 'PURCHASE', 'TRANSFER', 'ASSIGNMENT', 'EXPENDITURE', 'ADJUSTMENT')),
  ref_id            INTEGER NOT NULL,
  ref_reference     TEXT    NOT NULL DEFAULT '',
  quantity          INTEGER NOT NULL CHECK (quantity > 0),  -- always the magnitude
  direction         TEXT    NOT NULL CHECK (direction IN ('IN', 'OUT')),
  delta_on_hand     INTEGER NOT NULL,                       -- signed effect on on-hand
  delta_committed   INTEGER NOT NULL DEFAULT 0,             -- signed effect on issued/committed
  balance_on_hand   INTEGER NOT NULL CHECK (balance_on_hand >= 0),
  balance_committed INTEGER NOT NULL DEFAULT 0 CHECK (balance_committed >= 0),
  effective_date    TEXT    NOT NULL,                       -- ISO date used for reporting
  note              TEXT    NOT NULL DEFAULT '',
  actor_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  request_id        TEXT,                                    -- correlates to the API log entry
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ledger_base_equipment_date
  ON stock_ledger(base_id, equipment_type_id, effective_date);
CREATE INDEX IF NOT EXISTS idx_ledger_ref ON stock_ledger(ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON stock_ledger(created_at);

-- The ledger is a legal record: block UPDATE and DELETE at the engine level.
-- (PostgreSQL equivalent: a rule/trigger raising an exception, or a
--  BEFORE UPDATE OR DELETE trigger - see docs/DATABASE.md.)
CREATE TRIGGER IF NOT EXISTS trg_stock_ledger_immutable_update
BEFORE UPDATE ON stock_ledger
BEGIN
  SELECT RAISE(ABORT, 'stock_ledger is append-only and cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS trg_stock_ledger_immutable_delete
BEFORE DELETE ON stock_ledger
BEGIN
  SELECT RAISE(ABORT, 'stock_ledger is append-only and cannot be deleted');
END;

-- -----------------------------------------------------------------------------
-- Audit / API logging
-- -----------------------------------------------------------------------------

-- One row per *state-changing or sensitive* API call. Combined with the
-- structured request log (stdout / pino) this satisfies the "API logging for
-- auditing" requirement with a queryable, tamper-evident-ish store.
CREATE TABLE IF NOT EXISTS audit_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id     TEXT    NOT NULL,
  actor_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_username TEXT    NOT NULL DEFAULT 'anonymous',
  actor_role     TEXT    NOT NULL DEFAULT '',
  action         TEXT    NOT NULL,             -- e.g. PURCHASE_CREATE
  entity_type    TEXT    NOT NULL DEFAULT '',
  entity_id      TEXT    NOT NULL DEFAULT '',
  method         TEXT    NOT NULL,
  path           TEXT    NOT NULL,
  status_code    INTEGER NOT NULL,
  outcome        TEXT    NOT NULL DEFAULT 'SUCCESS'
                 CHECK (outcome IN ('SUCCESS', 'DENIED', 'FAILURE')),
  ip_address     TEXT    NOT NULL DEFAULT '',
  user_agent     TEXT    NOT NULL DEFAULT '',
  before_state   TEXT,                          -- JSON snapshot
  after_state    TEXT,                          -- JSON snapshot
  message        TEXT    NOT NULL DEFAULT '',
  duration_ms    INTEGER,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_logs(request_id);

-- -----------------------------------------------------------------------------
-- Document numbering
-- -----------------------------------------------------------------------------

-- Human-readable, gap-free-per-year document references (PO-2026-0042). An atomic
-- counter row beats "SELECT MAX(reference)+1" because the latter races under
-- concurrent inserts and produces duplicate keys under load.
-- PostgreSQL equivalent: a sequence per document type, or the same table with
-- `UPDATE ... RETURNING`.
CREATE TABLE IF NOT EXISTS document_sequences (
  doc_type TEXT    NOT NULL,
  period   TEXT    NOT NULL,                    -- e.g. '2026'
  next_val INTEGER NOT NULL DEFAULT 1 CHECK (next_val > 0),
  PRIMARY KEY (doc_type, period)
);
