/**
 * Per-user permission overrides — grant or deny on top of role-derived access.
 *
 * Source of truth: Employee Authentication milestone.
 *
 * Roles alone decide most access (`roles.ts`). This file adds the one thing
 * roles cannot express: an exception for one specific person. A Manager or
 * Managing Partner carving out an exception for a named user is legitimate
 * and must be visible as an exception, not blended silently into "what their
 * role gives them".
 *
 * Precedence is deterministic and total: an explicit DENY beats an explicit
 * GRANT, which beats the role-derived answer. A deny blocks the permission
 * outright, at every scope — it is a decision about the permission, not a
 * scope negotiation. A grant widens the role-derived scope up to at least the
 * scope it was written at, and never narrows what a role already gives.
 *
 * `hasPermission` in `index.ts` is untouched by this file and still answers
 * the role-only question (what a role grants in the abstract). Anywhere an
 * actual person's access is being decided — `session.can()`, the store's
 * `authorize()` / `canActOnCase()` — resolves through `hasPermissionWithOverrides`
 * instead, so there is exactly one place per real access decision.
 */

import { PERMISSIONS, findPermission } from "./actions.js";
import { ROLE_GRANTS, type Role } from "./roles.js";
import { scopeSatisfies, widestScope, type Scope } from "./scopes.js";

export type OverrideDecision = "grant" | "deny";

export interface PermissionOverride {
  readonly permission: string;
  readonly scope: Scope;
  readonly decision: OverrideDecision;
}

function roleDerivedScope(roles: readonly Role[], permission: string): Scope | null {
  return widestScope(
    roles.flatMap((role) =>
      ROLE_GRANTS[role]
        .filter((grant) => grant.permission === permission)
        .map((grant) => grant.scope),
    ),
  );
}

function grantOverrideScope(
  overrides: readonly PermissionOverride[],
  permission: string,
): Scope | null {
  return widestScope(
    overrides
      .filter((o) => o.permission === permission && o.decision === "grant")
      .map((o) => o.scope),
  );
}

function isDenied(overrides: readonly PermissionOverride[], permission: string): boolean {
  return overrides.some((o) => o.permission === permission && o.decision === "deny");
}

/**
 * Does a user holding these roles, with these individual overrides, hold
 * `permission` at at least `required` scope?
 */
export function hasPermissionWithOverrides(
  roles: readonly Role[],
  overrides: readonly PermissionOverride[],
  permission: string,
  required: Scope = "own",
): boolean {
  if (findPermission(permission) === undefined) {
    return false;
  }

  if (isDenied(overrides, permission)) {
    return false;
  }

  const held = widestScope(
    [roleDerivedScope(roles, permission), grantOverrideScope(overrides, permission)].filter(
      (s): s is Scope => s !== null,
    ),
  );

  return held !== null && scopeSatisfies(held, required);
}

/** Where an effective permission's answer came from — for admin-facing display, never silent. */
export type EffectivePermissionStatus =
  | { readonly kind: "role"; readonly scope: Scope }
  | { readonly kind: "override_grant"; readonly scope: Scope; readonly roleScope: Scope | null }
  | { readonly kind: "override_deny"; readonly roleScope: Scope | null }
  | { readonly kind: "none" };

/**
 * Every permission in the catalog, with the effective answer for this user
 * and where it came from. Built for the User Management screen's "effective
 * access" display (BR: an override must be shown as an override).
 */
export function effectivePermissionsWithOverrides(
  roles: readonly Role[],
  overrides: readonly PermissionOverride[],
): ReadonlyMap<string, EffectivePermissionStatus> {
  const result = new Map<string, EffectivePermissionStatus>();

  for (const permission of PERMISSIONS) {
    const key = permission.key;
    const roleScope = roleDerivedScope(roles, key);

    if (isDenied(overrides, key)) {
      result.set(key, { kind: "override_deny", roleScope });
      continue;
    }

    const grantScope = grantOverrideScope(overrides, key);
    if (grantScope !== null) {
      const held = widestScope(
        [roleScope, grantScope].filter((s): s is Scope => s !== null),
      ) as Scope;
      result.set(key, { kind: "override_grant", scope: held, roleScope });
      continue;
    }

    if (roleScope !== null) {
      result.set(key, { kind: "role", scope: roleScope });
      continue;
    }

    result.set(key, { kind: "none" });
  }

  return result;
}
