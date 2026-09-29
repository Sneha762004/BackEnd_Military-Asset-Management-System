import { Router } from 'express';
import { z } from 'zod';
import { ACTIONS, RESOURCES, p } from '../config/rbac.js';
import { getDb, inTransaction } from '../db/connection.js';
import { authenticate } from '../middleware/auth.js';
import { authorize, canAccessBase, resolveTargetBaseId } from '../middleware/rbac.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { audit, recordAuditedEntity } from '../middleware/audit.js';
import { validate, zId, zShortText, zText } from '../middleware/validate.js';
import { conflict } from '../utils/errors.js';
import type { AppRequest } from '../types/index.js';

/**
 * Read-mostly reference data: installations, equipment classes and personnel.
 * Every authenticated user can read these (they are needed to render any form);
 * creation is Admin-only, or Base-scoped for personnel.
 */
export const catalogueRouter = Router();

catalogueRouter.use(authenticate);

// ---------------------------------------------------------------- bases -----

interface BaseRow {
  id: number;
  code: string;
  name: string;
  location: string;
  country: string;
  commander: string;
  is_active: number;
  created_at: string;
}

/** GET /api/catalogue/bases */
catalogueRouter.get(
  '/bases',
  authorize(p(RESOURCES.BASE, ACTIONS.READ)),
  asyncHandler((req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT id, code, name, location, country, commander, is_active, created_at
           FROM bases
          WHERE is_active = 1
       ORDER BY code`,
      )
      .all() as BaseRow[];

    // A base-scoped principal only ever receives their own installation, so the
    // dropdown on the client cannot offer them a base they may not act on.
    const data = rows.filter((row) => canAccessBase(req as AppRequest, row.id));
    res.json({ data });
  }),
);

/**
 * GET /api/catalogue/bases/transfer-destinations
 *
 * The bases a transfer may be *sent to*. This is deliberately not the same list
 * as `/bases`: a base-scoped officer sees only their own installation there,
 * which would leave the transfer form with nothing to send to - the one option
 * would be their own base, and sending to yourself is refused. Knowing which
 * installations exist is not a disclosure; it is the minimum needed to raise a
 * movement, and it grants no access to the destination's stock or documents.
 *
 * Scope is enforced on the document itself: `resolveTargetBaseId` pins the
 * sending base to the caller's own, so this list can widen the choice of
 * destination without ever widening what may be sent from.
 */
catalogueRouter.get(
  '/bases/transfer-destinations',
  authorize(p(RESOURCES.BASE, ACTIONS.READ)),
  asyncHandler((req, res) => {
    const principal = req as AppRequest;
    const rows = getDb()
      .prepare(
        `SELECT id, code, name, location, country, commander, is_active, created_at
           FROM bases
          WHERE is_active = 1
       ORDER BY code`,
      )
      .all() as BaseRow[];

    const ownBaseId = principal.user?.baseId ?? null;
    const data = rows.filter((row) => row.id !== ownBaseId);
    res.json({ data });
  }),
);

const baseSchema = z.object({
  code: zShortText.max(20).regex(/^[A-Z0-9-]+$/i, 'Code may contain letters, digits and hyphens only'),
  name: zShortText,
  location: z.string().trim().max(200).default(''),
  country: z.string().trim().max(100).default(''),
  commander: z.string().trim().max(120).default(''),
});

/** POST /api/catalogue/bases - Admin only. */
catalogueRouter.post(
  '/bases',
  audit('BASE_CREATE', 'base'),
  authorize(p(RESOURCES.BASE, ACTIONS.CREATE)),
  validate(baseSchema),
  asyncHandler((req, res) => {
    const body = req.body as z.infer<typeof baseSchema>;
    const db = getDb();
    const existing = db.prepare('SELECT id FROM bases WHERE code = ? COLLATE NOCASE').get(body.code);
    if (existing) throw conflict(`A base with code '${body.code}' already exists.`);

    const info = db
      .prepare(
        `INSERT INTO bases (code, name, location, country, commander) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(body.code, body.name, body.location, body.country, body.commander);

    const id = Number(info.lastInsertRowid);
    recordAuditedEntity(req, id, { ...body });
    res.status(201).json({ data: { id, ...body } });
  }),
);

// -------------------------------------------------------- equipment types ---

interface EquipmentRow {
  id: number;
  code: string;
  name: string;
  category: string;
  unit: string;
  serialised: number;
  description: string;
  is_active: number;
}

/** GET /api/catalogue/equipment */
catalogueRouter.get(
  '/equipment',
  authorize(p(RESOURCES.EQUIPMENT, ACTIONS.READ)),
  asyncHandler((req, res) => {
    const category = typeof req.query.category === 'string' ? req.query.category : null;
    const rows = getDb()
      .prepare(
        `SELECT id, code, name, category, unit, serialised, description, is_active
           FROM equipment_types
          WHERE is_active = 1
            AND (@category IS NULL OR category = @category)
       ORDER BY category, name`,
      )
      .all({ category }) as EquipmentRow[];
    res.json({ data: rows });
  }),
);

const equipmentSchema = z.object({
  code: zShortText.max(30).regex(/^[A-Z0-9-]+$/i, 'Code may contain letters, digits and hyphens only'),
  name: zShortText,
  category: z.enum(['WEAPON', 'VEHICLE', 'AMMUNITION', 'EQUIPMENT', 'SPARES', 'FUEL']),
  unit: z.string().trim().min(1).max(20).default('unit'),
  serialised: z.boolean().default(false),
  description: zText,
});

/** POST /api/catalogue/equipment - Admin only. */
catalogueRouter.post(
  '/equipment',
  audit('EQUIPMENT_CREATE', 'equipmentType'),
  authorize(p(RESOURCES.EQUIPMENT, ACTIONS.CREATE)),
  validate(equipmentSchema),
  asyncHandler((req, res) => {
    const body = req.body as z.infer<typeof equipmentSchema>;
    const db = getDb();
    if (db.prepare('SELECT id FROM equipment_types WHERE code = ? COLLATE NOCASE').get(body.code)) {
      throw conflict(`An equipment type with code '${body.code}' already exists.`);
    }
    const info = db
      .prepare(
        `INSERT INTO equipment_types (code, name, category, unit, serialised, description)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(body.code, body.name, body.category, body.unit, body.serialised ? 1 : 0, body.description);

    const id = Number(info.lastInsertRowid);
    recordAuditedEntity(req, id, body);
    res.status(201).json({ data: { id, ...body } });
  }),
);

// ------------------------------------------------------------- personnel ---

interface PersonnelRow {
  id: number;
  service_number: string;
  full_name: string;
  rank: string;
  unit: string;
  base_id: number;
  base_code: string;
  base_name: string;
  is_active: number;
}

/** GET /api/catalogue/personnel - Base-scoped to the caller's own base. */
catalogueRouter.get(
  '/personnel',
  authorize(p(RESOURCES.PERSONNEL, ACTIONS.READ)),
  asyncHandler((req, res) => {
    const scopeBase = ownBaseOrNull(req as AppRequest);
    const rows = getDb()
      .prepare(
        `SELECT p.id, p.service_number, p.full_name, p.rank, p.unit, p.base_id,
                b.code AS base_code, b.name AS base_name, p.is_active
           FROM personnel p
           JOIN bases b ON b.id = p.base_id
          WHERE p.is_active = 1
            AND (@baseId IS NULL OR p.base_id = @baseId)
       ORDER BY p.rank, p.full_name`,
      )
      .all({ baseId: scopeBase }) as PersonnelRow[];
    res.json({ data: rows });
  }),
);

const personnelSchema = z.object({
  serviceNumber: zShortText.max(30),
  fullName: zShortText,
  rank: z.string().trim().max(60).default(''),
  unit: z.string().trim().max(120).default(''),
  baseId: zId.nullish(),
});

/** POST /api/catalogue/personnel */
catalogueRouter.post(
  '/personnel',
  audit('PERSONNEL_CREATE', 'personnel'),
  authorize(p(RESOURCES.PERSONNEL, ACTIONS.CREATE)),
  validate(personnelSchema),
  asyncHandler((req, res) => {
    const body = req.body as z.infer<typeof personnelSchema>;
    const baseId = resolveTargetBaseId(req as AppRequest, body.baseId ?? null);
    const db = getDb();

    if (db.prepare('SELECT id FROM personnel WHERE service_number = ? COLLATE NOCASE').get(body.serviceNumber)) {
      throw conflict(`Service number '${body.serviceNumber}' is already registered.`);
    }

    const id = inTransaction((tx) => {
      const info = tx
        .prepare(
          `INSERT INTO personnel (service_number, full_name, rank, unit, base_id) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(body.serviceNumber, body.fullName, body.rank, body.unit, baseId);
      return Number(info.lastInsertRowid);
    });

    recordAuditedEntity(req, id, { ...body, baseId });
    res.status(201).json({ data: { id, ...body, baseId } });
  }),
);

// A GLOBAL-scope role sees all personnel; a BASE-scoped role only its own base.
function ownBaseOrNull(req: AppRequest): number | null {
  if (!req.user) return null;
  return req.user.role === 'ADMIN' ? null : req.user.baseId;
}
