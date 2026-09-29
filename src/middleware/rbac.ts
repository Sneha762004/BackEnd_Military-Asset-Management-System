import type { NextFunction, Request, Response } from 'express';
import { forbidden, outOfScope } from '../utils/errors.js';
import type { AppRequest } from '../types/index.js';
import { hasAllPermissions, ROLE_SCOPE, type Permission } from '../config/rbac.js';

/**
 * RBAC gate. Mount *after* `authenticate`.
 *
 *   router.post('/', authenticate, authorize(P.purchase, 'create'), handler)
 *
 * A route that forgets `authenticate` is a bug we want to fail loudly on, so we
 * throw rather than silently allowing.
 */
export function authorize(...required: Permission[]) {
  return function authorizeMiddleware(req: Request, _res: Response, next: NextFunction): void {
    const user = (req as AppRequest).user;
    if (!user) {
      next(forbidden('Authentication context missing on a protected route.'));
      return;
    }
    if (!hasAllPermissions(user.role, required)) {
      next(forbidden(`Role '${user.role}' is missing permission: ${required.join(', ')}`));
      return;
    }
    next();
  };
}

export interface BaseScope {
  /** Base id the request is confined to, or `null` when unrestricted. */
  baseId: number | null;
  /** `'all'` for global roles, otherwise the caller's base code. */
  label: string;
}

export function resolveBaseScope(req: AppRequest): BaseScope {
  const user = req.user;
  if (!user) return { baseId: null, label: 'all' };
  if (ROLE_SCOPE[user.role] === 'GLOBAL' || user.baseId === null) {
    return { baseId: null, label: 'all' };
  }
  return { baseId: user.baseId, label: user.baseCode ?? String(user.baseId) };
}

/**
 * Resolves the base a write must target, honouring role scope.
 *
 * A BASE-scoped role may name its own base, or omit it; it can never name
 * another one. A GLOBAL role may name any base. Returns the effective base id
 * (never `undefined`, so callers do not have to null-check).
 */
export function resolveTargetBaseId(req: AppRequest, requested?: number | null): number {
  const user = req.user;
  if (!user) throw forbidden('Authentication context missing on a protected route.');

  const scope = resolveBaseScope(req);
  if (scope.baseId !== null) {
    if (requested != null && requested !== scope.baseId) {
      throw outOfScope(
        `Your account is restricted to base ${scope.label}; you cannot act on base id ${requested}.`,
      );
    }
    return scope.baseId;
  }

  if (requested == null) {
    // Name the field and the remedy. "A base must be specified" sent an admin
    // hunting through the app; the fix is always "pick a sending base".
    throw outOfScope(
      'A base must be specified for this operation. A global role has no default base, ' +
        'so choose which base this applies to and submit again.',
    );
  }
  return requested;
}

/**
 * Guards a single record that has already been loaded: throws 403 rather than
 * 404 when the row exists but belongs to another base. Returning 404 would hide
 * the existence of other bases' data; returning 403 is honest and auditable.
 */
export function assertWithinScope(req: AppRequest, recordBaseId: number | null, description: string): void {
  const scope = resolveBaseScope(req);
  if (scope.baseId === null) return;
  if (recordBaseId !== scope.baseId) {
    throw outOfScope(`${description} belongs to a base outside your scope.`);
  }
}

/** Convenience predicate for controllers that branch on visibility. */
export function canAccessBase(req: AppRequest, baseId: number | null): boolean {
  const scope = resolveBaseScope(req);
  return scope.baseId === null || scope.baseId === baseId;
}
