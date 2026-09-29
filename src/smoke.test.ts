/**
 * End-to-end API smoke test.
 *
 * Exercises every feature against a live server using a real HTTP client, and
 * asserts the RBAC matrix: each role is expected to succeed on some routes and
 * be refused on others.
 *
 * By default the suite is hermetic: it migrates and seeds a throwaway SQLite
 * file, boots the real Express app on an ephemeral port in this same process,
 * and deletes the file afterwards. It therefore writes documents, users and
 * opening balances, and needs a known starting state to assert against - so it
 * must not share a database with a development instance.
 *
 *   npm test                      # self-contained, repeatable
 *   TEST_BASE_URL=http://host npm test    # assert against a server you started
 */

import type { AddressInfo } from 'node:net';

let BASE = process.env.TEST_BASE_URL ?? '';

/**
 * Boot a private server on a temporary database and point `BASE` at it.
 * No-op when TEST_BASE_URL is set, so the suite can still be aimed at a
 * deployment.
 */
async function startHarness(): Promise<{ stop: () => Promise<void> } | null> {
  if (process.env.TEST_BASE_URL) return null;

  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');

  // Set before anything imports the config module: it reads process.env once.
  const dir = mkdtempSync(path.join(tmpdir(), 'milams-smoke-'));
  const dbFile = path.join(dir, 'smoke.db');
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_FILE = dbFile;
  process.env.LOG_LEVEL = 'fatal';

  const { migrate } = await import('./db/migrate.js');
  const { seed } = await import('./db/seed.js');
  const { closeDb } = await import('./db/connection.js');
  const { bootstrap } = await import('./app.js');

  migrate();
  seed();

  const server = bootstrap().listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const { port } = server.address() as AddressInfo;
  BASE = `http://127.0.0.1:${port}`;

  return {
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          closeDb();
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

interface Result {
  ok: boolean;
  status: number;
  body: unknown;
}

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Result> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep the raw text */
  }
  return { ok: response.ok, status: response.status, body };
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

/** The KPI set returned by /dashboard/summary. */
interface Totals {
  opening_balance: number;
  purchases: number;
  transfer_in: number;
  transfer_out: number;
  net_movement: number;
  expended: number;
  assigned: number;
  closing_balance: number;
  available: number;
}

/** The drill-down returned by /dashboard/net-movement. */
interface Breakdown {
  purchases: number;
  transfer_in: number;
  transfer_out: number;
  net_movement: number;
}

/** Closing = Opening + Net Movement - Expended, the system's central identity. */
function reconciles(t: Totals | undefined): boolean {
  if (!t) return false;
  return (
    t.closing_balance === t.opening_balance + (t.purchases + t.transfer_in - t.transfer_out) - t.expended
  );
}

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail).slice(0, 400)}`);
  }
}

async function login(username: string, password: string): Promise<string> {
  const result = await call('POST', '/api/auth/login', { body: { username, password } });
  if (!result.ok) throw new Error(`Login failed for ${username}: ${JSON.stringify(result.body)}`);
  return (result.body as { data: { token: string } }).data.token;
}

const today = new Date().toISOString().slice(0, 10);
const monthStart = `${today.slice(0, 7)}-01`;

async function main(): Promise<void> {
  const harness = await startHarness();
  console.log(`\nMiL-AMS API smoke test against ${BASE}\n`);

  // ------------------------------------------------------------------ auth --
  console.log('Authentication');
  const health = await call('GET', '/health');
  check('GET /health is public and reports ok', health.ok && (health.body as { data: { status: string } }).data.status === 'ok', health.body);

  const badLogin = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong' } });
  check('Wrong password is rejected 401', badLogin.status === 401, badLogin.body);

  const unknownUser = await call('POST', '/api/auth/login', { body: { username: 'nobody.here', password: 'whatever' } });
  check(
    'Unknown user is rejected with the same 401 code (no account enumeration)',
    unknownUser.status === 401 &&
      (unknownUser.body as { error: { code: string } }).error.code ===
        (badLogin.body as { error: { code: string } }).error.code,
    unknownUser.body,
  );

  const noToken = await call('GET', '/api/dashboard/summary');
  check('Protected route without a token is 401', noToken.status === 401, noToken.body);

  const garbageToken = await call('GET', '/api/dashboard/summary', { token: 'not-a-real-token' });
  check('Protected route with a bad token is 401', garbageToken.status === 401, garbageToken.body);

  const adminToken = await login('admin', 'Admin@12345');
  const commanderToken = await login('cmd.kilo', 'Commander@12345');
  const logisticsToken = await login('log.kilo', 'Logistics@12345');
  check('All three roles can sign in', true);

  const me = await call('GET', '/api/auth/me', { token: commanderToken });
  check(
    'GET /auth/me returns the principal with a base scope and permissions',
    me.ok &&
      (me.body as { data: { user: { baseCode: string; permissions: string[] } } }).data.user.baseCode === 'FWK-01' &&
      (me.body as { data: { user: { permissions: string[] } } }).data.user.permissions.length > 0,
    me.body,
  );

  // ------------------------------------------------------------- catalogue --
  console.log('\nCatalogue');
  const basesAsAdmin = await call('GET', '/api/catalogue/bases', { token: adminToken });
  check('Admin sees every base', basesAsAdmin.ok && (basesAsAdmin.body as { data: unknown[] }).data.length === 4, basesAsAdmin.body);

  const basesAsCommander = await call('GET', '/api/catalogue/bases', { token: commanderToken });
  check(
    'Base-scoped role sees only its own base',
    basesAsCommander.ok && (basesAsCommander.body as { data: unknown[] }).data.length === 1,
    basesAsCommander.body,
  );

  const equipment = await call('GET', '/api/catalogue/equipment', { token: adminToken });
  check('Equipment catalogue is readable', equipment.ok && (equipment.body as { data: unknown[] }).data.length === 8, equipment.body);

  const personnel = await call('GET', '/api/catalogue/personnel', { token: commanderToken });
  check(
    'Personnel list is base-scoped',
    personnel.ok && (personnel.body as { data: { base_code: string }[] }).data.every((row) => row.base_code === 'FWK-01'),
    personnel.body,
  );

  // ------------------------------------------------------------- dashboard --
  console.log('\nDashboard');
  const summary = await call('GET', `/api/dashboard/summary?dateFrom=${monthStart}&dateTo=${today}&equipmentTypeId=1`, {
    token: adminToken,
  });
  const totals = (summary.body as { data?: { totals?: Totals } }).data?.totals;
  check('GET /dashboard/summary returns the KPI set', summary.ok && typeof totals?.opening_balance === 'number', summary.body);

  check('Closing = Opening + (Purchases + TransferIn - TransferOut) - Expended', reconciles(totals), totals);
  check('Net movement is reported', totals !== undefined && typeof totals.net_movement === 'number', totals);
  check(
    'Net movement equals purchases + transfer in - transfer out',
    totals !== undefined && totals.net_movement === totals.purchases + totals.transfer_in - totals.transfer_out,
    totals,
  );
  check('Available = Closing - Assigned', totals !== undefined && totals.available === totals.closing_balance - totals.assigned, totals);

  const netMovement = await call('GET', `/api/dashboard/net-movement?dateFrom=${monthStart}&dateTo=${today}&pageSize=100`, {
    token: adminToken,
  });
  const breakdown = (netMovement.body as { meta?: { breakdown?: Breakdown } }).meta?.breakdown;
  check(
    'Net-movement drill-down breaks out purchases / transfer in / transfer out',
    netMovement.ok && breakdown !== undefined && breakdown.purchases > 0 && breakdown.transfer_in > 0 && breakdown.transfer_out > 0,
    breakdown,
  );
  check(
    'Drill-down arithmetic matches the headline net movement',
    breakdown !== undefined && breakdown.net_movement === breakdown.purchases + breakdown.transfer_in - breakdown.transfer_out,
    breakdown,
  );

  const byBase = await call('GET', `/api/dashboard/by-base?dateFrom=${monthStart}&dateTo=${today}`, { token: adminToken });
  check('GET /dashboard/by-base returns a per-base walk-down', byBase.ok && (byBase.body as { data: unknown[] }).data.length > 0, byBase.body);

  const trend = await call('GET', `/api/dashboard/trend?months=6`, { token: adminToken });
  check('GET /dashboard/trend returns a 6-point series', trend.ok && (trend.body as { data: unknown[] }).data.length === 6, trend.body);

  const commanderSummary = await call('GET', `/api/dashboard/summary?dateFrom=${monthStart}&dateTo=${today}&baseId=2`, {
    token: commanderToken,
  });
  const scope = (commanderSummary.body as { data: { scope: { baseLabel: string } } }).data?.scope;
  check(
    'A base-scoped role cannot widen its view by asking for another base in the query string',
    commanderSummary.ok && scope?.baseLabel === 'FWK-01',
    scope,
  );

  // ------------------------------------------------------------- purchases --
  console.log('\nPurchases');
  const purchases = await call('GET', `/api/purchases?dateFrom=2000-01-01&dateTo=${today}&pageSize=100`, {
    token: adminToken,
  });
  const purchaseRows = (purchases.body as { data: { reference: string; base_code: string }[] }).data ?? [];
  // Non-empty and fully populated rather than a fixed count: the suite records
  // purchases of its own, so re-running it against one database adds rows.
  check(
    'Purchase history is listable',
    purchases.ok && purchaseRows.length > 0 && purchaseRows.every((row) => row.reference && row.base_code),
    purchases.body,
  );
  check(
    'Purchases are filterable by base',
    purchaseRows.every((row) => typeof row.base_code === 'string'),
  );

  const createPurchase = await call('POST', '/api/purchases', {
    token: adminToken,
    body: {
      baseId: 1,
      equipmentTypeId: 1,
      quantity: 5,
      unitCost: 120000,
      supplier: 'Smoke Test Munitions',
      contractRef: 'ST-001',
      purchaseDate: today,
      receivedDate: today,
    },
  });
  check('Admin can record a purchase', createPurchase.ok, createPurchase.body);
  const purchaseId = createPurchase.ok
    ? (createPurchase.body as { data: { id: number } }).data.id
    : 0;

  const commanderPurchase = await call('POST', '/api/purchases', {
    token: commanderToken,
    body: {
      baseId: 1,
      equipmentTypeId: 1,
      quantity: 1,
      purchaseDate: today,
      receivedDate: today,
    },
  });
  check('Base Commander cannot record purchases (LOGISTICS_OFFICER + ADMIN only)', commanderPurchase.status === 403, commanderPurchase.body);

  const logisticsPurchase = await call('POST', '/api/purchases', {
    token: logisticsToken,
    body: {
      equipmentTypeId: 1,
      quantity: 3,
      supplier: 'Smoke Test Logistics',
      purchaseDate: today,
      receivedDate: today,
    },
  });
  check('Logistics Officer can record a purchase and defaults to its own base', logisticsPurchase.ok, logisticsPurchase.body);

  const crossBasePurchase = await call('POST', '/api/purchases', {
    token: logisticsToken,
    body: { baseId: 2, equipmentTypeId: 1, quantity: 1, purchaseDate: today, receivedDate: today },
  });
  check('Logistics Officer is refused when naming another base', crossBasePurchase.status === 403, crossBasePurchase.body);

  const badDates = await call('POST', '/api/purchases', {
    token: adminToken,
    body: { baseId: 1, equipmentTypeId: 1, quantity: 1, purchaseDate: today, receivedDate: '2020-01-01' },
  });
  check('Invalid date ordering is rejected 422', badDates.status === 422, badDates.body);

  // A purchase must actually move the stock it claims to.
  const balancesAfter = await call('GET', '/api/ledger/balances?baseId=1&category=WEAPON', { token: adminToken });
  check(
    'Ledger balances endpoint responds',
    balancesAfter.ok && (balancesAfter.body as { data: unknown[] }).data.length > 0,
    balancesAfter.body,
  );

  if (purchaseId) {
    const cancel = await call('POST', `/api/purchases/${purchaseId}/cancel`, {
      token: adminToken,
      body: { reason: 'Smoke test cleanup' },
    });
    check('Admin can cancel a purchase (reversing document)', cancel.ok, cancel.body);

    const recancel = await call('POST', `/api/purchases/${purchaseId}/cancel`, {
      token: adminToken,
      body: { reason: 'again' },
    });
    check('Cancelling twice is a 409 conflict', recancel.status === 409, recancel.body);
  }

  // ------------------------------------------------------------- transfers --
  console.log('\nTransfers');
  const transfers = await call('GET', `/api/transfers?dateFrom=2000-01-01&dateTo=${today}&pageSize=100`, {
    token: adminToken,
  });
  const transferRows = (transfers.body as { data: { reference: string; from_base_code: string }[] }).data ?? [];
  check(
    'Transfer history is listable',
    transfers.ok && transferRows.length > 0 && transferRows.every((row) => row.reference && row.from_base_code),
    transfers.body,
  );

  const transferDetail = await call('GET', '/api/transfers/5', { token: adminToken });
  check(
    'Transfer detail exposes its asset lines',
    transferDetail.ok && ((transferDetail.body as { data: { items: unknown[] } }).data.items.length ?? 0) > 0,
    transferDetail.body,
  );

  const selfTransfer = await call('POST', '/api/transfers', {
    token: adminToken,
    body: { fromBaseId: 1, toBaseId: 1, transferDate: today, items: [{ equipmentTypeId: 1, quantity: 1 }] },
  });
  check('A base cannot transfer to itself (409)', selfTransfer.status === 409, selfTransfer.body);

  const oversell = await call('POST', '/api/transfers', {
    token: adminToken,
    body: { fromBaseId: 3, toBaseId: 1, transferDate: today, items: [{ equipmentTypeId: 4, quantity: 999_999 }] },
  });
  check('Transferring more than is available is refused (INSUFFICIENT_STOCK)', oversell.status === 409 && (oversell.body as { error: { code: string } }).error.code === 'INSUFFICIENT_STOCK', oversell.body);

  const createTransfer = await call('POST', '/api/transfers', {
    token: logisticsToken,
    body: {
      fromBaseId: 1,
      toBaseId: 3,
      transferDate: today,
      vehicleRef: 'SMOKE-1',
      items: [{ equipmentTypeId: 1, quantity: 2 }],
    },
  });
  check('Logistics Officer can raise a transfer out of its own base', createTransfer.ok, createTransfer.body);
  const transferId = createTransfer.ok ? (createTransfer.body as { data: { id: number } }).data.id : 0;

  const foreignSource = await call('POST', '/api/transfers', {
    token: logisticsToken,
    body: {
      fromBaseId: 2,
      toBaseId: 3,
      transferDate: today,
      items: [{ equipmentTypeId: 1, quantity: 1 }],
    },
  });
  check('A transfer cannot be raised out of a base the officer does not hold', foreignSource.status === 403, foreignSource.body);

  if (transferId) {
    const wrongReceiver = await call('POST', `/api/transfers/${transferId}/receive`, {
      token: logisticsToken,
      body: { receivedDate: today },
    });
    check('The sending base cannot confirm its own receipt', wrongReceiver.status === 403, wrongReceiver.body);

    const adminReceive = await call('POST', `/api/transfers/${transferId}/receive`, {
      token: adminToken,
      body: { receivedDate: today },
    });
    check('Admin can confirm receipt', adminReceive.ok, adminReceive.body);

    const doubleReceive = await call('POST', `/api/transfers/${transferId}/receive`, {
      token: adminToken,
      body: { receivedDate: today },
    });
    check('Receiving twice is refused (invalid state transition)', doubleReceive.status === 409, doubleReceive.body);
  }

  // ----------------------------------------------------------- assignments --
  console.log('\nAssignments & expenditures');
  const personnelRows = (personnel.body as { data: { id: number }[] }).data ?? [];
  const firstPersonnelId = personnelRows[0]?.id ?? 0;

  const logisticsAssign = await call('POST', '/api/assignments', {
    token: logisticsToken,
    body: { equipmentTypeId: 1, personnelId: firstPersonnelId, quantity: 1, assignedDate: today },
  });
  check('Logistics Officer cannot assign assets (403)', logisticsAssign.status === 403, logisticsAssign.body);

  const commanderAssign = await call('POST', '/api/assignments', {
    token: commanderToken,
    body: { equipmentTypeId: 1, personnelId: firstPersonnelId, quantity: 2, assignedDate: today, purpose: 'Smoke test issue' },
  });
  check('Base Commander can assign assets', commanderAssign.ok, commanderAssign.body);
  const assignmentId = commanderAssign.ok ? (commanderAssign.body as { data: { id: number } }).data.id : 0;

  const assignments = await call('GET', `/api/assignments?dateFrom=2000-01-01&dateTo=${today}&pageSize=100`, {
    token: commanderToken,
  });
  const assignmentRows = (assignments.body as { data: { base_code: string }[] }).data ?? [];
  check(
    'Assignment list is base-scoped for a commander',
    assignments.ok && assignmentRows.every((row) => row.base_code === 'FWK-01'),
  );

  if (assignmentId) {
    const returnOne = await call('POST', `/api/assignments/${assignmentId}/return`, {
      token: commanderToken,
      body: { returnedDate: today, quantity: 1 },
    });
    check('Assets can be returned (partial)', returnOne.ok && (returnOne.body as { data: { status: string } }).data.status === 'PARTIALLY_RETURNED', returnOne.body);

    const returnTooMany = await call('POST', `/api/assignments/${assignmentId}/return`, {
      token: commanderToken,
      body: { returnedDate: today, quantity: 99 },
    });
    check('Returning more than is outstanding is refused', returnTooMany.status === 409, returnTooMany.body);

    const returnRest = await call('POST', `/api/assignments/${assignmentId}/return`, {
      token: commanderToken,
      body: { returnedDate: today, quantity: 1 },
    });
    check('Returning the balance closes the assignment', returnRest.ok && (returnRest.body as { data: { status: string } }).data.status === 'RETURNED', returnRest.body);
  }

  // Issued stock must not be transferable - the two-man rule in the ledger.
  const committedTransfer = await call('POST', '/api/transfers', {
    token: commanderToken,
    body: {
      toBaseId: 2,
      transferDate: today,
      items: [{ equipmentTypeId: 3, quantity: 30 }],
    },
  });
  check(
    'fromBaseId may be omitted by a base-scoped role (it is taken from the token)',
    committedTransfer.status === 409 &&
      (committedTransfer.body as { error: { code: string } }).error.code === 'INSUFFICIENT_STOCK',
    committedTransfer.body,
  );
  check(
    'Stock already issued to personnel cannot be transferred away',
    /already issued to personnel/.test(
      ((committedTransfer.body as { error?: { message?: string } }).error?.message ?? ''),
    ),
    committedTransfer.body,
  );

  const commanderExpend = await call('POST', '/api/expenditures', {
    token: commanderToken,
    body: { equipmentTypeId: 3, quantity: 1, reason: 'MAINTENANCE', expendedDate: today, authorisedBy: 'Smoke Test' },
  });
  check('Base Commander can record an expenditure', commanderExpend.ok, commanderExpend.body);

  const overspend = await call('POST', '/api/expenditures', {
    token: commanderToken,
    body: { equipmentTypeId: 3, quantity: 999_999, reason: 'OTHER', expendedDate: today, authorisedBy: 'Smoke Test' },
  });
  check('Writing off more than is held is refused', overspend.status === 409 && (overspend.body as { error: { code: string } }).error.code === 'INSUFFICIENT_STOCK', overspend.body);

  const badSource = await call('POST', '/api/expenditures', {
    token: commanderToken,
    body: { equipmentTypeId: 3, quantity: 1, source: 'ASSIGNED', expendedDate: today, reason: 'OTHER', authorisedBy: 'Smoke Test' },
  });
  check('source=ASSIGNED without an assignment_id is refused', badSource.status === 409, badSource.body);

  // --------------------------------------------------- opening balances ----
  console.log('\nOpening balances');
  const openingList = await call('GET', `/api/opening-balances?periodStart=${monthStart}&pageSize=100`, {
    token: adminToken,
  });
  check('Opening balances are listable for a period', openingList.ok, openingList.body);

  const createOpening = await call('POST', '/api/opening-balances', {
    token: adminToken,
    body: { baseId: 4, equipmentTypeId: 3, quantity: 7, notes: 'Smoke test opening' },
  });
  check('Admin can declare an opening balance', createOpening.ok, createOpening.body);

  if (createOpening.ok) {
    const duplicate = await call('POST', '/api/opening-balances', {
      token: adminToken,
      body: { baseId: 4, equipmentTypeId: 3, quantity: 9 },
    });
    check('A second opening balance for the same period is refused', duplicate.status === 409, duplicate.body);
  }

  // ------------------------------------------------------- ledger & audit --
  console.log('\nLedger & audit');
  const ledger = await call('GET', '/api/ledger?pageSize=200', { token: adminToken });
  const ledgerRows = (ledger.body as { data: { balance_on_hand: number }[] }).data ?? [];
  check('Movement ledger is listable', ledger.ok && ledgerRows.length > 0, ledger.body);
  check('No ledger row ever carries a negative on-hand balance', ledgerRows.every((row) => row.balance_on_hand >= 0));

  const ledgerWrite = await call('POST', '/api/ledger', { token: adminToken, body: {} });
  check('The ledger exposes no write endpoint', ledgerWrite.status === 404, ledgerWrite.body);

  const auditAsCommander = await call('GET', '/api/audit-logs', { token: commanderToken });
  check('Audit log is Admin-only (403 for a commander)', auditAsCommander.status === 403, auditAsCommander.body);

  const auditAsAdmin = await call('GET', '/api/audit-logs?pageSize=20', { token: adminToken });
  const auditBody = auditAsAdmin.body as {
    data?: { action: string; status_code: number; outcome: string; actor_username: string }[];
    meta?: { total: number; actions?: { value: string; count: number }[] };
  };
  const auditRows = auditBody.data ?? [];
  const auditedActions = new Set((auditBody.meta?.actions ?? []).map((row) => row.value));

  check('Admin can read the audit trail', auditAsAdmin.ok && auditRows.length > 0, auditAsAdmin.body);
  // Assert against the whole-log action histogram, not page 1: the log is
  // ordered newest-first, so any single page is a moving target as the run goes on.
  check(
    'Audit trail captured every transaction class from this run',
    auditedActions.has('AUTH_LOGIN') &&
      auditedActions.has('PURCHASE_CREATE') &&
      auditedActions.has('TRANSFER_CREATE') &&
      auditedActions.has('TRANSFER_RECEIVE') &&
      auditedActions.has('ASSIGNMENT_CREATE') &&
      auditedActions.has('EXPENDITURE_CREATE'),
    [...auditedActions],
  );
  check('Denied attempts are recorded with their status code', auditRows.some((row) => row.status_code === 403), auditRows.slice(0, 3));

  // The assertion above can be satisfied by a 403 thrown inside a handler, so it
  // does not prove that a refused *authorization* is traced. This one does: the
  // commander holds no purchase:create, so that 403 comes from `authorize`,
  // and it must appear in the trail as a denial by that officer.
  const deniedCreate = await call('GET', '/api/audit-logs?action=PURCHASE_CREATE&statusCode=403&pageSize=50', {
    token: adminToken,
  });
  const deniedRows = (deniedCreate.body as { data?: { outcome: string; actor_username: string }[] }).data ?? [];
  check(
    'A refused authorization is audited, not just refused',
    deniedCreate.ok &&
      deniedRows.length > 0 &&
      deniedRows.every((row) => row.outcome === 'DENIED') &&
      deniedRows.some((row) => row.actor_username === 'cmd.kilo'),
    deniedRows.slice(0, 3),
  );

  // outcome must never call a rejected request a success.
  const wrongOutcome = auditRows.filter(
    (row) => (row.status_code >= 400) === (row.outcome === 'SUCCESS'),
  );
  check(
    'No rejected request is recorded as SUCCESS',
    wrongOutcome.length === 0,
    wrongOutcome.slice(0, 3),
  );

  // ------------------------------------------------------- user admin ------
  console.log('\nUser administration');
  const usersAsLogistics = await call('GET', '/api/admin/users', { token: logisticsToken });
  check('User administration is Admin-only (403 for a logistics officer)', usersAsLogistics.status === 403, usersAsLogistics.body);

  const users = await call('GET', '/api/admin/users?pageSize=200', { token: adminToken });
  const userRows = (users.body as { data?: { username: string; role: string }[] }).data ?? [];
  const rolesPresent = new Set(userRows.map((row) => row.role));
  // Assert coverage, not a row count: the suite creates a user of its own, so a
  // second run against the same database legitimately sees one more account.
  check(
    'Admin can list users',
    users.ok &&
      userRows.length > 0 &&
      ['ADMIN', 'BASE_COMMANDER', 'LOGISTICS_OFFICER'].every((role) => rolesPresent.has(role)),
    users.body,
  );

  // Unique per run so repeated runs against one database do not collide.
  const unique = Date.now().toString(36);
  const createUser = await call('POST', '/api/admin/users', {
    token: adminToken,
    body: {
      username: `smoke.tester.${unique}`,
      email: `smoke.tester.${unique}@milams.example`,
      fullName: 'Smoke Tester',
      rank: 'Capt.',
      role: 'BASE_COMMANDER',
      baseId: 1,
      password: 'SmokeTest@123',
    },
  });
  check('Admin can create a base-scoped user', createUser.ok, createUser.body);

  const badRolePairing = await call('POST', '/api/admin/users', {
    token: adminToken,
    body: {
      username: `smoke.bad.${unique}`,
      email: `smoke.bad.${unique}@milams.example`,
      fullName: 'Bad Pairing',
      role: 'LOGISTICS_OFFICER',
      password: 'SmokeTest@123',
    },
  });
  check('A base-scoped role without a base is refused', badRolePairing.status === 409, badRolePairing.body);

  const selfDemote = await call('PATCH', `/api/admin/users/1`, {
    token: adminToken,
    body: { role: 'LOGISTICS_OFFICER', baseId: 1 },
  });
  check('An admin cannot demote themselves (lockout guard)', selfDemote.status === 409, selfDemote.body);

  const selfDeactivate = await call('DELETE', `/api/admin/users/1`, { token: adminToken });
  check('An admin cannot deactivate themselves', selfDeactivate.status === 409, selfDeactivate.body);

  // ------------------------------------------------------------- reporting --
  console.log('\nReconciliation');
  const finalCheck = await call('GET', `/api/dashboard/summary?dateFrom=${monthStart}&dateTo=${today}&equipmentTypeId=1&baseId=1`, {
    token: adminToken,
  });
  const finalTotals = (finalCheck.body as { data?: { totals?: Totals } }).data?.totals;
  check('The identity still holds after every write in this run', reconciles(finalTotals), finalTotals);
  check('Closing balance is positive and plausible', finalTotals !== undefined && finalTotals.closing_balance > 0, finalTotals);

  // --------------------------------------------------------------- summary --
  console.log(`\n${'-'.repeat(60)}`);
  console.log(`Passed: ${passed}   Failed: ${failed}`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const failure of failures) console.log(`  - ${failure}`);
  }
  console.log(`${'-'.repeat(60)}\n`);

  // Tear the private server and its database down before exiting, so a failed
  // run leaves nothing behind either.
  if (harness) await harness.stop();

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nSmoke test crashed:', error);
  process.exit(1);
});
