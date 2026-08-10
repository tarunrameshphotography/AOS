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
  type PermissionOverride,
  type Role,
  type Scope,
} from "@domain/permissions/index.js";

/**
 * Who is making the request.
 *
 * `overrides` carries the actor's LIVE per-user grants and denials, read fresh
 * from `user_permission_override` on every request by `loadOverrides`
 * (Backend/users.ts) — as of Stage 3A. Through Stage 2 it was hard-coded to
 * `[]`: the table existed (migration 0029) but had no reader and no writer,
 * because the Employee Authentication milestone put overrides on an in-memory
 * `AppUser` in the browser store and nothing server-side ever consulted them.
 *
 * Read per request rather than baked into the session token, for the same
 * reason roles are: a manager who withdraws an exception expects it to stop
 * applying now, not whenever that employee next logs in.
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
 * Every candidate is asked through `can()`, which consults roles AND overrides
 * together. Nothing here reads `ROLE_GRANTS` directly.
 *
 * IT USED TO, AND THAT WAS A BUG. Stage 2 computed the role-derived scope
 * first and refused to consider any candidate wider than it, on the stated
 * grounds that a denial must not be widened by a role grant sitting at a
 * broader scope. That reasoning was wrong twice over: `can()` already handles
 * denials — a deny blocks the permission at every scope, so no candidate can
 * pass — and the cap made an override GRANT unable to widen anything. It was
 * invisible while `Actor.overrides` was always `[]`, and became a live defect
 * the moment Stage 3A started loading them: a Telecaller granted `case.read`
 * at `all` could open a colleague's case by URL (which goes through `can()`)
 * but saw an empty list on the cases screen (which comes through here). An
 * override that half-applies is worse than one that does not apply at all.
 */
export function widestScopeFor(actor: Actor, permission: string): Scope | null {
  for (const candidate of ["all", "team", "own"] as const) {
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
