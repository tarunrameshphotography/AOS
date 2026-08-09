/**
 * Server-side authorization.
 *
 * THE POINT OF THIS FILE: until now every permission check in AOS ran in the
 * browser, inside `Frontend/src/fake/store.ts`. A check that runs in the
 * client is advice, not enforcement — anyone who can open devtools can call
 * the function that follows it. This module answers the same questions on the
 * server, where the answer is binding.
 *
 * IT DOES NOT RE-IMPLEMENT THE MODEL. Every decision routes through
 * `hasPermissionWithOverrides` from `@domain/permissions`, the same function
 * the store and the UI already call, and the same catalog migration 0008 seeds
 * `role_permission` from. ADR-022 exists precisely so this question has one
 * implementation; a second one written "for the backend" is the drift it
 * forbids.
 */

import {
  hasPermissionWithOverrides,
  scopeSatisfies,
  widestScope,
  ROLE_GRANTS,
  type PermissionOverride,
  type Role,
  type Scope,
} from "@domain/permissions/index.js";

/**
 * Who is making the request.
 *
 * `overrides` is presently always empty: `permission_override` has no table in
 * the schema. The Employee Authentication milestone put per-user grants and
 * denials on the in-memory `AppUser` and no migration ever gave them a home.
 * That gap is real and is recorded in the Stage 2 report rather than papered
 * over — passing `[]` is honest ("this installation has no overrides"), and
 * the moment the table exists this is the only line that changes.
 */
export interface Actor {
  readonly userId: string;
  readonly authIdentityId: string;
  readonly roles: readonly Role[];
  readonly overrides: readonly PermissionOverride[];
}

/**
 * A deactivated user holds no roles at all — the same rule `actorRoles()` in
 * the store applies, and the reason deactivation bites at the write layer
 * rather than only at the login screen.
 *
 * Applied when the actor is built (`loadActor`), so an inactive user never
 * becomes an `Actor` in the first place.
 */
export function can(actor: Actor, permission: string, scope: Scope = "own"): boolean {
  return hasPermissionWithOverrides(actor.roles, actor.overrides, permission, scope);
}

/**
 * The widest scope this actor holds for a permission, or null for none.
 *
 * This is what turns a permission into a SQL filter: `all` reads everything,
 * `own` reads only rows the actor owns, null reads nothing and the request is
 * refused before a query is built.
 *
 * Overrides are consulted through `can()` rather than read out of
 * `ROLE_GRANTS` directly, so an explicit denial cannot be widened by a role
 * grant that happens to sit at a broader scope.
 */
export function widestScopeFor(actor: Actor, permission: string): Scope | null {
  const fromRoles = widestScope(
    actor.roles.flatMap((role) =>
      ROLE_GRANTS[role].filter((g) => g.permission === permission).map((g) => g.scope),
    ),
  );

  for (const candidate of ["all", "team", "own"] as const) {
    if (fromRoles !== null && !scopeSatisfies(fromRoles, candidate)) continue;
    if (can(actor, permission, candidate)) return candidate;
  }
  return null;
}

/**
 * May this actor act on this specific case?
 *
 * Holding the permission at `all`, or at `own` while actually owning the case.
 * This mirrors `canActOnCase` in the store exactly — deliberately, because the
 * two must agree: the UI hides what the server refuses, and a disagreement
 * shows up as a button that produces an error.
 */
export function canActOnCase(
  actor: Actor,
  ownerUserId: string,
  permission: string,
): boolean {
  return (
    can(actor, permission, "all") ||
    (can(actor, permission, "own") && ownerUserId === actor.userId)
  );
}

/** Refusal text. Deliberately says which permission was missing — an employee
 * who cannot act needs to be able to tell their manager what to grant — and
 * deliberately says nothing about whether the row exists. */
export function refusal(permission: string): string {
  return `You do not have permission to do that (${permission}).`;
}
