import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { ACTIONS, RESOURCES, p, isRoleKey, publicRoleCatalogue } from '../config/rbac.js';
import { config } from '../config/env.js';
import { getDb, inTransaction, nowIso } from '../db/connection.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/rbac.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { audit, recordAuditedEntity } from '../middleware/audit.js';
import { paginationSchema, validate, zId, zShortText } from '../middleware/validate.js';
import { conflict, invalidStateTransition, notFound } from '../utils/errors.js';
import { offsetOf, orderBy, pageMeta } from '../utils/query.js';
import type { AppRequest } from '../types/index.js';

export const adminRouter = Router();

// Every route below is Admin-only. Applied once at the router so a route added
// later cannot accidentally be exposed to a lesser role.
adminRouter.use(authenticate);

interface UserRow {
  id: number;
  username: string;
  email: string;
  full_name: string;
  rank: string;
  role: string;
  role_name: string;
  base_id: number | null;
  base_code: string | null;
  base_name: string | null;
  is_active: number;
  last_login_at: string | null;
  created_at: string;
}

const SELECT_USER = `
  SELECT u.id, u.username, u.email, u.full_name, u.rank,
         r.key AS role, r.name AS role_name,
         u.base_id, b.code AS base_code, b.name AS base_name,
         u.is_active, u.last_login_at, u.created_at
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN bases b ON b.id = u.base_id`;

/** GET /api/admin/users */
adminRouter.get(
  '/users',
  authorize(p(RESOURCES.USER, ACTIONS.READ)),
  validate(paginationSchema, 'query'),
  validate(z.object({ role: z.string().trim().max(30).optional(), baseId: zId.optional(), search: z.string().trim().max(120).optional() }), 'query'),
  asyncHandler((req, res) => {
    const { page, pageSize, sort, order } = req.query as unknown as z.infer<typeof paginationSchema>;
    const role = typeof req.query.role === 'string' ? req.query.role : null;
    const baseId = typeof req.query.baseId === 'string' ? Number(req.query.baseId) : null;
    const search = typeof req.query.search === 'string' && req.query.search ? `%${req.query.search}%` : null;

    const where = `
      (@role IS NULL OR r.key = @role)
      AND (@baseId IS NULL OR u.base_id = @baseId)
      AND (@search IS NULL OR u.username LIKE @search OR u.full_name LIKE @search OR u.email LIKE @search)`;
    const params = { role, baseId, search };
    const db = getDb();

    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE ${where}`).get(params) as {
        n: number;
      }
    ).n;

    const items = db
      .prepare(
        `${SELECT_USER} WHERE ${where} ORDER BY ${orderBy({ sort, order }, 'u.username')}
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: pageSize, offset: offsetOf(page, pageSize) }) as UserRow[];

    res.json({ data: items, meta: pageMeta(total, page, pageSize) });
  }),
);

/** GET /api/admin/roles */
adminRouter.get('/roles', authorize(p(RESOURCES.USER, ACTIONS.READ)), (_req, res) => {
  res.json({ data: publicRoleCatalogue() });
});

const createUserSchema = z.object({
  username: zShortText.max(64).regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, digits, dot, underscore or hyphen only'),
  email: z.string().trim().toLowerCase().email('A valid email is required'),
  fullName: zShortText,
  rank: z.string().trim().max(60).default(''),
  role: z.string().trim().min(1),
  baseId: zId.nullish(),
  password: z
    .string()
    .min(10, 'Password must be at least 10 characters')
    .max(200)
    .regex(/[A-Z]/, 'Must contain an upper-case letter')
    .regex(/[a-z]/, 'Must contain a lower-case letter')
    .regex(/[0-9]/, 'Must contain a digit')
    .regex(/[^A-Za-z0-9]/, 'Must contain a symbol'),
});

/**
 * POST /api/admin/users
 *
 * The base/role pairing is validated here rather than in a trigger: a GLOBAL
 * role must not be pinned to one base (it would then be silently downgraded),
 * and a BASE-scoped role must be pinned, otherwise `resolveBaseScope` would let
 * it see every base in the system.
 */
adminRouter.post(
  '/users',
  audit('USER_CREATE', 'user'),
  authorize(p(RESOURCES.USER, ACTIONS.CREATE)),
  validate(createUserSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createUserSchema>;
    const db = getDb();

    if (!isRoleKey(body.role)) throw conflict(`Unknown role '${body.role}'.`);

    const roleRow = db.prepare('SELECT id, scope FROM roles WHERE key = ?').get(body.role) as
      | { id: number; scope: 'GLOBAL' | 'BASE' }
      | undefined;
    if (!roleRow) throw conflict(`Unknown role '${body.role}'.`);

    if (roleRow.scope === 'BASE' && !body.baseId) {
      throw conflict('A Base Commander or Logistics Officer must be assigned to a base.');
    }
    if (roleRow.scope === 'GLOBAL' && body.baseId) {
      throw conflict('A global role such as Admin cannot be pinned to a single base.');
    }
    if (body.baseId && !db.prepare('SELECT id FROM bases WHERE id = ? AND is_active = 1').get(body.baseId)) {
      throw notFound('Base', body.baseId);
    }
    if (db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(body.username)) {
      throw conflict(`Username '${body.username}' is already taken.`);
    }
    if (db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(body.email)) {
      throw conflict(`Email '${body.email}' is already registered.`);
    }

    const hash = await bcrypt.hash(body.password, config.auth.bcryptRounds);
    const actor = (req as AppRequest).user!;

    const id = inTransaction((tx) => {
      const info = tx
        .prepare(
          `INSERT INTO users (username, email, full_name, rank, password_hash, role_id, base_id, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(body.username, body.email, body.fullName, body.rank, hash, roleRow.id, body.baseId ?? null, actor.id);
      return Number(info.lastInsertRowid);
    });

    recordAuditedEntity(req, id, {
      username: body.username,
      role: body.role,
      baseId: body.baseId ?? null,
    });
    res.status(201).json({ data: { id, username: body.username } });
  }),
);

const updateUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().optional(),
  fullName: zShortText.optional(),
  rank: z.string().trim().max(60).optional(),
  role: z.string().trim().optional(),
  baseId: zId.nullable().optional(),
  isActive: z.boolean().optional(),
});

/** PATCH /api/admin/users/:id */
adminRouter.patch(
  '/users/:id',
  audit('USER_UPDATE', 'user'),
  authorize(p(RESOURCES.USER, ACTIONS.UPDATE)),
  validate(z.object({ id: zId }), 'params'),
  validate(updateUserSchema),
  asyncHandler((req, res) => {
    const id = Number(req.params.id);
    const body = req.body as z.infer<typeof updateUserSchema>;
    const actor = (req as AppRequest).user!;
    const db = getDb();

    const before = db.prepare(`${SELECT_USER} WHERE u.id = ?`).get(id) as UserRow | undefined;
    if (!before) throw notFound('User', id);

    // Self-lockout guard: an admin who removes their own admin rights, or
    // deactivates themselves, can leave the system with no administrator.
    if (before.id === actor.id) {
      if (body.isActive === false) throw invalidStateTransition('You cannot deactivate your own account.');
      if (body.role && body.role !== before.role) {
        throw invalidStateTransition('You cannot change your own role. Ask another administrator.');
      }
    }

    const roleKey = body.role ?? before.role;
    if (!isRoleKey(roleKey)) throw conflict(`Unknown role '${roleKey}'.`);
    const roleRow = db.prepare('SELECT id, scope FROM roles WHERE key = ?').get(roleKey) as
      | { id: number; scope: 'GLOBAL' | 'BASE' }
      | undefined;
    if (!roleRow) throw conflict(`Unknown role '${roleKey}'.`);

    const nextBaseId = body.baseId === undefined ? before.base_id : body.baseId;
    if (roleRow.scope === 'BASE' && !nextBaseId) {
      throw conflict('A Base Commander or Logistics Officer must be assigned to a base.');
    }
    if (roleRow.scope === 'GLOBAL' && nextBaseId) {
      throw conflict('A global role such as Admin cannot be pinned to a single base.');
    }

    if (body.email && body.email !== before.email) {
      if (db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id <> ?').get(body.email, id)) {
        throw conflict(`Email '${body.email}' is already registered.`);
      }
    }

    db.prepare(
      `UPDATE users
          SET email = @email, full_name = @fullName, rank = @rank, role_id = @roleId,
              base_id = @baseId, is_active = @isActive, updated_at = @updatedAt
        WHERE id = @id`,
    ).run({
      id,
      email: body.email ?? before.email,
      fullName: body.fullName ?? before.full_name,
      rank: body.rank ?? before.rank,
      roleId: roleRow.id,
      baseId: roleRow.scope === 'GLOBAL' ? null : nextBaseId,
      isActive: body.isActive === undefined ? before.is_active : body.isActive ? 1 : 0,
      updatedAt: nowIso(),
    });

    recordAuditedEntity(req, id, { before, after: body });
    res.json({ data: { id, updated: true } });
  }),
);

/**
 * DELETE /api/admin/users/:id
 *
 * Soft delete only. Users are referenced by every document they ever raised
 * (`ON DELETE RESTRICT` on the ledger actor), and an accountability system that
 * deleted its own witnesses would be worthless - so accounts are deactivated and
 * every past transaction keeps its author.
 */
adminRouter.delete(
  '/users/:id',
  audit('USER_DEACTIVATE', 'user'),
  authorize(p(RESOURCES.USER, ACTIONS.DELETE)),
  validate(z.object({ id: zId }), 'params'),
  asyncHandler((req, res) => {
    const id = Number(req.params.id);
    const actor = (req as AppRequest).user!;
    if (id === actor.id) throw invalidStateTransition('You cannot deactivate your own account.');

    const before = getDb().prepare(`${SELECT_USER} WHERE u.id = ?`).get(id) as UserRow | undefined;
    if (!before) throw notFound('User', id);
    if (!before.is_active) throw conflict('This account is already deactivated.');

    getDb()
      .prepare('UPDATE users SET is_active = 0, updated_at = ? WHERE id = ?')
      .run(nowIso(), id);

    recordAuditedEntity(req, id, { before, after: { is_active: 0 } });
    res.json({ data: { id, is_active: 0 } });
  }),
);
