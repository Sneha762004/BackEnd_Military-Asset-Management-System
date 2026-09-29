import type { Request } from 'express';
import type { Permission, RoleKey } from '../config/rbac.js';

/** The authenticated principal, attached to `req` by `authenticate()`. */
export interface AuthenticatedUser {
  id: number;
  username: string;
  fullName: string;
  rank: string;
  role: RoleKey;
  permissions: Permission[];
  /** `null` means the principal is not base-restricted (ADMIN). */
  baseId: number | null;
  baseCode: string | null;
  baseName: string | null;
}

export interface RequestContext {
  requestId: string;
  startedAt: number;
}

export interface AppRequest extends Request {
  user?: AuthenticatedUser;
  ctx?: RequestContext;
  /** Populated by `captureAuditState` for the audit trail. */
  audit?: {
    action: string;
    entityType: string;
    entityId?: string | number;
    message?: string;
    before?: unknown;
    after?: unknown;
  };
}

/** Standard envelope used by every successful response. */
export interface ApiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}
