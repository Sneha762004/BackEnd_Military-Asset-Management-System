import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { ROLE_DEFINITIONS, type RoleKey } from '../config/rbac.js';
import { getDb } from '../db/connection.js';
import { tokenExpired, unauthenticated } from '../utils/errors.js';
import type { AppRequest } from '../types/index.js';

export interface JwtPayload {
  sub: number;
  username: string;
  role: RoleKey;
  baseId: number | null;
}

export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.auth.jwtSecret, {
    expiresIn: config.auth.jwtExpiresIn,
    issuer: 'milams-api',
    audience: 'milams-web',
  } as jwt.SignOptions);
}

function extractBearer(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim();
}

/**
 * Verifies the bearer token and rebuilds the principal from the *database*, not
 * from the token body. The token only carries an identity; permissions and base
 * scope are re-read on every request, so suspending a user or moving a commander
 * to another base takes effect immediately instead of at token expiry.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearer(req);
  if (!token) {
    next(unauthenticated('Missing bearer token.'));
    return;
  }

  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, config.auth.jwtSecret, {
      issuer: 'milams-api',
      audience: 'milams-web',
    }) as unknown as JwtPayload;
  } catch (error) {
    next(error instanceof jwt.TokenExpiredError ? tokenExpired() : unauthenticated('Invalid authentication token.'));
    return;
  }

  try {
    const row = getDb()
      .prepare(
        `SELECT u.id, u.username, u.full_name, u.rank, u.is_active,
                r.key AS role,
                u.base_id, b.code AS base_code, b.name AS base_name
           FROM users u
           JOIN roles r ON r.id = u.role_id
      LEFT JOIN bases b ON b.id = u.base_id
          WHERE u.id = ?`,
      )
      .get(payload.sub) as
      | {
          id: number;
          username: string;
          full_name: string;
          rank: string;
          is_active: number;
          role: string;
          base_id: number | null;
          base_code: string | null;
          base_name: string | null;
        }
      | undefined;

    if (!row) {
      next(unauthenticated('Account no longer exists.'));
      return;
    }
    if (!row.is_active) {
      next(unauthenticated('Account has been deactivated.'));
      return;
    }
    if (!(row.role in ROLE_DEFINITIONS)) {
      next(unauthenticated('Account has an unrecognised role.'));
      return;
    }

    const role = row.role as RoleKey;
    (req as AppRequest).user = {
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
    next();
  } catch (error) {
    next(error);
  }
}
