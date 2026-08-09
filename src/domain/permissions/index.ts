/**
 * The permission model.
 *
 * Source of truth: PRD/Permissions.md, ADR-022, ADR-026, ADR-027
 *
 * Four files, one job each:
 *
 * - `scopes.ts`  — what `own` / `team` / `all` mean, and what `own` means per family.
 * - `actions.ts` — the catalog: every action AOS recognises.
 * - `roles.ts`   — who holds what, enumerated, every entry scoped.
 * - `tables.ts`  — every table bound to the permissions governing its operations.
 *
 * `role_permission` is seeded from `roles.ts` by migration and RLS policies read
 * that table. Nothing here is restated in SQL by hand.
 */

export {
  SCOPES,
  SCOPE_FAMILIES,
  SCOPE_FAMILY_DEFINITIONS,
  scopeSatisfies,
  widestScope,
  type Scope,
  type ScopeFamily,
} from "./scopes.js";

export {
  PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_LEVELS,
  columnLevelPermissions,
  findPermission,
  permissionKeys,
  type PermissionDefinition,
  type PermissionGroup,
  type PermissionLevel,
} from "./actions.js";

export {
  ROLES,
  ROLE_GRANTS,
  ROLE_LABELS,
  DELIBERATELY_UNASSIGNED,
  grantsForRoles,
  type Grant,
  type Role,
} from "./roles.js";

export {
  TABLE_BINDINGS,
  NON_TABLE_PERMISSIONS,
  findTableBinding,
  permissionsReferencedByTables,
  tableNames,
  type MaskedColumn,
  type OperationBinding,
  type TableBinding,
} from "./tables.js";

export {
  hasPermissionWithOverrides,
  effectivePermissionsWithOverrides,
  type EffectivePermissionStatus,
  type OverrideDecision,
  type PermissionOverride,
} from "./overrides.js";

export { PERMISSION_DISPLAY_NAME, permissionDisplayName } from "./display.js";

import { PERMISSIONS, findPermission } from "./actions.js";
import { ROLE_GRANTS, type Role } from "./roles.js";
import { scopeSatisfies, widestScope, type Scope } from "./scopes.js";

/**
 * Does a user holding these roles hold this permission at at least this scope?
 *
 * The single implementation of the check. `app.has_permission()` in Postgres
 * answers the same question against the seeded `role_permission` table, and the
 * seed comes from the same catalog — so the database and this function cannot
 * disagree about a grant, only about the data they were seeded with, which a
 * migration test covers.
 *
 * Returns false for an unknown permission rather than throwing: a policy that
 * refuses an action nobody defined is the safe direction.
 */
export function hasPermission(
  roles: readonly Role[],
  permission: string,
  required: Scope = "own",
): boolean {
  if (findPermission(permission) === undefined) {
    return false;
  }

  const held = widestScope(
    roles.flatMap((role) =>
      ROLE_GRANTS[role]
        .filter((grant) => grant.permission === permission)
        .map((grant) => grant.scope),
    ),
  );

  return held !== null && scopeSatisfies(held, required);
}

/** Every permission a set of roles holds, at the widest scope any of them grants (BR-061). */
export function effectivePermissions(roles: readonly Role[]): ReadonlyMap<string, Scope> {
  const effective = new Map<string, Scope>();

  for (const permission of PERMISSIONS) {
    const held = widestScope(
      roles.flatMap((role) =>
        ROLE_GRANTS[role]
          .filter((grant) => grant.permission === permission.key)
          .map((grant) => grant.scope),
      ),
    );
    if (held !== null) {
      effective.set(permission.key, held);
    }
  }

  return effective;
}
