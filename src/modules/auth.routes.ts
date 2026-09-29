import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config/env.js';
import { getDb, nowIso } from '../db/connection.js';
import { authenticate, signAccessToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { audit } from '../middleware/audit.js';
import { validate } from '../middleware/validate.js';
import { publicRoleCatalogue, ROLE_DEFINITIONS } from '../config/rbac.js';
import { invalidCredentials, unauthenticated } from '../utils/errors.js';
import type { AppRequest, AuthenticatedUser } from '../types/index.js';

export const authRouter = Router();

/** Tighter limiter on credential endpoints to blunt password guessing. */
const authLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  // Matches the global limiter: the smoke suite signs in many times per run, so
  // a leftover counter from earlier manual probing would fail the suite for a
  // reason that has nothing to do with the code under test.
  skip: () => config.isTest,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts. Try again later.' } },
});

const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username is required').max(64),
  password: z.string().min(1, 'Password is required').max(200),
});

interface UserRow {
  id: number;
  username: string;
  email: string;
  full_name: string;
  rank: string;
  password_hash: string;
  is_active: number;
  role: string;
  base_id: number | null;
  base_code: string | null;
  base_name: string | null;
}

const SELECT_USER = `
  SELECT u.id, u.username, u.email, u.full_name, u.rank, u.password_hash, u.is_active,
         r.key AS role, u.base_id, b.code AS base_code, b.name AS base_name
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN bases b ON b.id = u.base_id`;

/**
 * A syntactically valid bcrypt hash of an unguessable value, compared against
 * when the username does not exist. Without it, `bcrypt.compare` returns
 * immediately for an unknown user and the login endpoint leaks which usernames
 * are real via response timing.
 */
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

function toPrincipal(row: UserRow): AuthenticatedUser {
  const role = row.role as AuthenticatedUser['role'];
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    rank: row.rank,
    role,
    permissions: ROLE_DEFINITIONS[role].permissions,
    baseId: row.base_id,
    baseCode: row.base_code,
    baseName: row.base_name,
  };
}

/** POST /api/auth/login */
authRouter.post(
  '/login',
  authLimiter,
  audit('AUTH_LOGIN', 'user'),
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { username, password } = req.body as z.infer<typeof loginSchema>;
    const db = getDb();
    const row = db.prepare(`${SELECT_USER} WHERE u.username = ? COLLATE NOCASE`).get(username) as UserRow | undefined;

    // Uniform failure for "no such user", "wrong password" and "deactivated":
    // distinguishing them would let an unauthenticated caller enumerate accounts.
    // The dummy hash also equalises timing, so a missing account is not
    // measurably faster to reject than a wrong password.
    const hash = row?.password_hash ?? DUMMY_HASH;
    const passwordOk = await bcrypt.compare(password, hash);

    if (!row || !passwordOk || !row.is_active) {
      const err = invalidCredentials();
      (req as AppRequest).audit = { action: 'AUTH_LOGIN', entityType: 'user', message: err.message, entityId: username };
      throw err;
    }

    const user = toPrincipal(row);
    const token = signAccessToken({ sub: user.id, username: user.username, role: user.role, baseId: user.baseId });

    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);

    (req as AppRequest).audit = {
      action: 'AUTH_LOGIN',
      entityType: 'user',
      entityId: user.id,
      message: `${user.username} signed in`,
    };

    res.json({ data: { token, user } });
  }),
);

/** GET /api/auth/me - rehydrates the client session and its permission list. */
authRouter.get(
  '/me',
  authenticate,
  asyncHandler((req, res) => {
    res.json({ data: { user: (req as AppRequest).user } });
  }),
);

/** POST /api/auth/change-password */
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z
    .string()
    .min(10, 'New password must be at least 10 characters')
    .max(200)
    .regex(/[A-Z]/, 'Must contain an upper-case letter')
    .regex(/[a-z]/, 'Must contain a lower-case letter')
    .regex(/[0-9]/, 'Must contain a digit')
    .regex(/[^A-Za-z0-9]/, 'Must contain a symbol'),
  confirmPassword: z.string(),
}).refine((value) => value.newPassword === value.confirmPassword, {
  message: 'Password confirmation does not match',
  path: ['confirmPassword'],
});

authRouter.post(
  '/change-password',
  authenticate,
  authLimiter,
  audit('AUTH_CHANGE_PASSWORD', 'user'),
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const user = (req as AppRequest).user!;
    const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>;
    const db = getDb();

    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as
      | { password_hash: string }
      | undefined;
    if (!row) throw unauthenticated();

    if (!(await bcrypt.compare(currentPassword, row.password_hash))) {
      (req as AppRequest).audit = {
        action: 'AUTH_CHANGE_PASSWORD',
        entityType: 'user',
        entityId: user.id,
        message: 'Current password did not match',
      };
      throw invalidCredentials('Current password is incorrect.');
    }

    const hash = await bcrypt.hash(newPassword, config.auth.bcryptRounds);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, nowIso(), user.id);

    (req as AppRequest).audit = {
      action: 'AUTH_CHANGE_PASSWORD',
      entityType: 'user',
      entityId: user.id,
      message: 'Password changed',
    };

    res.json({ data: { changed: true } });
  }),
);

/**
 * GET /api/auth/roles - public within an authenticated session. The UI uses the
 * returned permission list to decide which navigation and buttons to render, so
 * the client and server never disagree about what a role can do.
 */
authRouter.get(
  '/roles',
  authenticate,
  asyncHandler((_req, res) => {
    res.json({ data: publicRoleCatalogue() });
  }),
);
