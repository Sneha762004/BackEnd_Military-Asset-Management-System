/**
 * Role-Based Access Control definition.
 *
 * Access is modelled as a permission string `"<resource>:<action>"` that a role
 * either has or does not. Routes declare the permissions they need; the
 * `authorize()` middleware enforces them. Base-scoped roles additionally have
 * their `base_id` forced into every query by `applyBaseScope()`.
 *
 * Why a permission string instead of hard-coding `if (role === 'ADMIN')` in
 * controllers: the security policy lives in exactly one auditable table, new
 * roles can be added without touching business logic, and the same list drives
 * what the React UI renders, so the frontend can never show a control the API
 * would reject.
 */

export const ROLES = {
  ADMIN: 'ADMIN',
  BASE_COMMANDER: 'BASE_COMMANDER',
  LOGISTICS_OFFICER: 'LOGISTICS_OFFICER',
} as const;

export type RoleKey = (typeof ROLES)[keyof typeof ROLES];

export const RESOURCES = {
  DASHBOARD: 'dashboard',
  BASE: 'base',
  USER: 'user',
  PERSONNEL: 'personnel',
  EQUIPMENT: 'equipment',
  OPENING_BALANCE: 'openingBalance',
  PURCHASE: 'purchase',
  TRANSFER: 'transfer',
  ASSIGNMENT: 'assignment',
  EXPENDITURE: 'expenditure',
  AUDIT: 'audit',
} as const;

export type Resource = (typeof RESOURCES)[keyof typeof RESOURCES];

export const ACTIONS = {
  READ: 'read',
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  APPROVE: 'approve',
} as const;

export type Action = (typeof ACTIONS)[keyof typeof ACTIONS];

export type Permission = `${Resource}:${Action}`;

export const p = (resource: Resource, action: Action): Permission => `${resource}:${action}`;

/** Does a role see one base only, or the whole theatre? */
export const ROLE_SCOPE: Record<RoleKey, 'GLOBAL' | 'BASE'> = {
  ADMIN: 'GLOBAL',
  BASE_COMMANDER: 'BASE',
  LOGISTICS_OFFICER: 'BASE',
};

export interface RoleDefinition {
  key: RoleKey;
  name: string;
  description: string;
  scope: 'GLOBAL' | 'BASE';
  permissions: Permission[];
}

const DASHBOARD_READ = p(RESOURCES.DASHBOARD, ACTIONS.READ);
const EQUIPMENT_READ = p(RESOURCES.EQUIPMENT, ACTIONS.READ);
const BASE_READ = p(RESOURCES.BASE, ACTIONS.READ);
const OPENING_READ = p(RESOURCES.OPENING_BALANCE, ACTIONS.READ);
const PURCHASE_READ = p(RESOURCES.PURCHASE, ACTIONS.READ);
const PURCHASE_CREATE = p(RESOURCES.PURCHASE, ACTIONS.CREATE);
const PURCHASE_UPDATE = p(RESOURCES.PURCHASE, ACTIONS.UPDATE);
const TRANSFER_READ = p(RESOURCES.TRANSFER, ACTIONS.READ);
const TRANSFER_CREATE = p(RESOURCES.TRANSFER, ACTIONS.CREATE);
const TRANSFER_UPDATE = p(RESOURCES.TRANSFER, ACTIONS.UPDATE);
const ASSIGNMENT_READ = p(RESOURCES.ASSIGNMENT, ACTIONS.READ);
const ASSIGNMENT_CREATE = p(RESOURCES.ASSIGNMENT, ACTIONS.CREATE);
const ASSIGNMENT_UPDATE = p(RESOURCES.ASSIGNMENT, ACTIONS.UPDATE);
const EXPENDITURE_READ = p(RESOURCES.EXPENDITURE, ACTIONS.READ);
const EXPENDITURE_CREATE = p(RESOURCES.EXPENDITURE, ACTIONS.CREATE);
const PERSONNEL_READ = p(RESOURCES.PERSONNEL, ACTIONS.READ);
const PERSONNEL_CREATE = p(RESOURCES.PERSONNEL, ACTIONS.CREATE);
const OPENING_CREATE = p(RESOURCES.OPENING_BALANCE, ACTIONS.CREATE);
const USER_READ = p(RESOURCES.USER, ACTIONS.READ);
const USER_MANAGE = p(RESOURCES.USER, ACTIONS.CREATE);
const AUDIT_READ = p(RESOURCES.AUDIT, ACTIONS.READ);
const EQUIPMENT_MANAGE = p(RESOURCES.EQUIPMENT, ACTIONS.CREATE);

export const ROLE_DEFINITIONS: Record<RoleKey, RoleDefinition> = {
  [ROLES.ADMIN]: {
    key: ROLES.ADMIN,
    name: 'System Administrator',
    description:
      'Full access to every base, every module and the user/audit administration screens. Accountable for the integrity of the system of record.',
    scope: 'GLOBAL',
    permissions: [
      DASHBOARD_READ,
      BASE_READ,
      USER_READ,
      USER_MANAGE,
      p(RESOURCES.USER, ACTIONS.UPDATE),
      p(RESOURCES.USER, ACTIONS.DELETE),
      PERSONNEL_READ,
      PERSONNEL_CREATE,
      EQUIPMENT_READ,
      EQUIPMENT_MANAGE,
      p(RESOURCES.EQUIPMENT, ACTIONS.UPDATE),
      OPENING_READ,
      OPENING_CREATE,
      p(RESOURCES.OPENING_BALANCE, ACTIONS.UPDATE),
      PURCHASE_READ,
      PURCHASE_CREATE,
      PURCHASE_UPDATE,
      p(RESOURCES.PURCHASE, ACTIONS.DELETE),
      TRANSFER_READ,
      TRANSFER_CREATE,
      TRANSFER_UPDATE,
      p(RESOURCES.TRANSFER, ACTIONS.APPROVE),
      ASSIGNMENT_READ,
      ASSIGNMENT_CREATE,
      ASSIGNMENT_UPDATE,
      p(RESOURCES.ASSIGNMENT, ACTIONS.DELETE),
      EXPENDITURE_READ,
      EXPENDITURE_CREATE,
      p(RESOURCES.EXPENDITURE, ACTIONS.DELETE),
      AUDIT_READ,
    ],
  },

  [ROLES.BASE_COMMANDER]: {
    key: ROLES.BASE_COMMANDER,
    name: 'Base Commander',
    description:
      'Command accountability for a single assigned base. Full read access to that base\'s movements, plus authority to assign and write off assets held there.',
    scope: 'BASE',
    permissions: [
      DASHBOARD_READ,
      BASE_READ,
      PERSONNEL_READ,
      PERSONNEL_CREATE,
      EQUIPMENT_READ,
      OPENING_READ,
      OPENING_CREATE,
      PURCHASE_READ,
      TRANSFER_READ,
      TRANSFER_CREATE,
      TRANSFER_UPDATE,
      ASSIGNMENT_READ,
      ASSIGNMENT_CREATE,
      ASSIGNMENT_UPDATE,
      EXPENDITURE_READ,
      EXPENDITURE_CREATE,
    ],
  },

  [ROLES.LOGISTICS_OFFICER]: {
    key: ROLES.LOGISTICS_OFFICER,
    name: 'Logistics Officer',
    description:
      'Limited to procurement and movement for the assigned base: raises and receives purchases and raises transfers. No authority to assign or write off assets, and no purchase amendment rights.',
    scope: 'BASE',
    permissions: [
      DASHBOARD_READ,
      BASE_READ,
      EQUIPMENT_READ,
      PURCHASE_READ,
      PURCHASE_CREATE,
      TRANSFER_READ,
      TRANSFER_CREATE,
    ],
  },
};

export const ALL_ROLES = Object.values(ROLE_DEFINITIONS);

export function isRoleKey(value: string): value is RoleKey {
  return Object.prototype.hasOwnProperty.call(ROLE_DEFINITIONS, value);
}

export function hasPermission(role: RoleKey, permission: Permission): boolean {
  return ROLE_DEFINITIONS[role].permissions.includes(permission);
}

export function hasAllPermissions(role: RoleKey, permissions: Permission[]): boolean {
  const granted = new Set(ROLE_DEFINITIONS[role].permissions);
  return permissions.every((perm) => granted.has(perm));
}

/** Role definitions minus the permission list - safe to send to any client. */
export function publicRoleCatalogue() {
  return ALL_ROLES.map(({ key, name, description, scope, permissions }) => ({
    key,
    name,
    description,
    scope,
    permissions,
  }));
}
