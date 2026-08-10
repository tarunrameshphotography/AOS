/**
 * User administration, server-side.
 *
 * Stage 3A of the Persistence milestone. Two things land together here because
 * they are the same feature seen from two ends:
 *
 *   1. **Permission overrides become real.** `user_permission_override` has
 *      existed since migration 0029 and had no writer and no reader — Stage 2's
 *      `Actor.overrides` was hard-coded to `[]`. `loadOverrides` below is the
 *      reader; `setOverride` / `revokeOverride` are the writers. From here, an
 *      exception granted to one named person is enforced by the server on
 *      every request, which is the only place enforcing it means anything.
 *
 *   2. **Accounts are administered through the API.** Creating employees,
 *      assigning roles, deactivating leavers and resetting passwords all lived
 *      in `Frontend/src/fake/store.ts`, where every check was advice. The rules
 *      that file carries are preserved here — see each handler — and the ones
 *      it could not enforce, because a single-browser prototype had no notion
 *      of concurrent administrators, are added.
 *
 * WHAT THIS DOES NOT DO: it never deletes an account. The store had a
 * `deleteUser` guarded by a history check; BR-062 requires a departed
 * employee's name to survive on everything they touched, and `app_user` is
 * referenced by ten-odd tables, so "delete when there is no history" is a race
 * against every one of them. Deactivation is the supported path and is what
 * the real accounts will use.
 */

import { randomUUID } from "node:crypto";

import { hashPassword, verifyPassword } from "@domain/auth/password.js";
import {
  ROLES,
  effectivePermissionsWithOverrides,
  findPermission,
  hasPermissionWithOverrides,
  type PermissionOverride,
  type Role,
  type Scope,
} from "@domain/permissions/index.js";

import type { Queryable } from "./db.js";
import { recordUserEvent } from "./events.js";
import type { Actor } from "./authorize.js";

/** Thrown by handlers, caught by the API server's error boundary. Declared
 * here rather than imported from api-server.ts, which imports this module —
 * the cycle is avoidable and the shape is two fields. */
export class UserAdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The shortest password this API will store.
 *
 * The prototype had no rule at all, which was defensible while every account
 * was a throwaway with a password written down in `seed-users.ts`. It stops
 * being defensible the moment six real employees hold accounts against real
 * customer files. Eight is the conventional floor, chosen not to be an
 * obstacle: the protection that matters here is that hashing is PBKDF2 and
 * the office network is not on the internet.
 */
const MIN_PASSWORD_LENGTH = 8;

// ---------------------------------------------------------------------------
// Reading overrides — the line Stage 2 said would be the only one to change
// ---------------------------------------------------------------------------

/**
 * The live permission overrides for one user.
 *
 * Revoked rows are excluded here and nowhere else: an override that was
 * withdrawn must stop affecting access immediately, and the partial index
 * `user_permission_override_user_idx` (0029) is built for exactly this
 * predicate. History stays in the table for the audit question — "what could
 * they do in March?" — which is a different query from this one.
 */
export async function loadOverrides(
  client: Queryable,
  userId: string,
): Promise<readonly PermissionOverride[]> {
  const { rows } = await client.query(
    `select permission, scope, decision
       from user_permission_override
      where user_id = $1 and revoked_at is null`,
    [userId],
  );
  return rows.map((row: { permission: string; scope: Scope; decision: "grant" | "deny" }) => ({
    permission: row.permission,
    scope: row.scope,
    decision: row.decision,
  }));
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

const USER_SELECT = `
  select u.id, u.username, u.is_active, u.last_login_at, u.created_at,
         p.full_name,
         coalesce(array_agg(r.role::text) filter (where r.revoked_at is null),
                  '{}'::text[]) as roles
    from app_user u
    join person p on p.id = u.person_id
    left join user_role r on r.user_id = u.id`;

function userFromRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    isActive: row.is_active,
    roles: row.roles,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

function requirePermission(actor: Actor, permission: string): void {
  if (!hasPermissionWithOverrides(actor.roles, actor.overrides, permission, "all")) {
    throw new UserAdminError(403, `You do not have permission to do that (${permission}).`);
  }
}

async function loadUserOr404(client: Queryable, userId: string) {
  const { rows } = await client.query(`${USER_SELECT} where u.id = $1 group by u.id, p.full_name`, [
    userId,
  ]);
  if (!rows[0]) throw new UserAdminError(404, "No such user.");
  return rows[0];
}

function parseRoles(value: unknown): Role[] {
  if (!Array.isArray(value)) {
    throw new UserAdminError(400, "Roles must be a list.");
  }
  const roles = value.map((r) => String(r));
  for (const role of roles) {
    if (!(ROLES as readonly string[]).includes(role)) {
      throw new UserAdminError(400, `Unknown role: ${role}.`);
    }
  }
  // BR-061 gives a user the union of their roles, so a duplicate changes
  // nothing about access — but it would violate `user_role_one_live_grant` on
  // insert and surface as a 500. Collapsing here keeps the client honest
  // without making it the client's problem.
  const unique = [...new Set(roles)] as Role[];
  if (unique.length === 0) {
    throw new UserAdminError(400, "At least one role is required.");
  }
  return unique;
}

/**
 * Refuse a change that would leave nobody able to administer users.
 *
 * THE FAILURE THIS PREVENTS: AOS has six accounts and no console. If the last
 * active holder of `user.manage` is deactivated, stripped of their roles, or
 * denied the permission by override, there is no supported way back in —
 * recovery means someone with the database password editing `user_role` by
 * hand at a psql prompt. That is not a theoretical risk at this size; the
 * three Managing Partners and the Manager are the only holders, and a
 * tidying-up session that deactivates "the accounts we don't use" can reach it.
 *
 * The prototype had no equivalent rule because a single-browser store had no
 * way to lock anyone out of anything. Checked AFTER the change, inside the
 * request's transaction, so the rollback undoes it — which also means it
 * catches every route uniformly rather than each one reasoning about its own
 * edge cases.
 */
async function assertAnAdministratorRemains(client: Queryable): Promise<void> {
  const { rows } = await client.query(
    `select u.id,
            coalesce(array_agg(r.role::text) filter (where r.revoked_at is null),
                     '{}'::text[]) as roles
       from app_user u
       left join user_role r on r.user_id = u.id
      where u.is_active
      group by u.id`,
  );

  for (const row of rows as { id: string; roles: string[] }[]) {
    const overrides = await loadOverrides(client, row.id);
    if (hasPermissionWithOverrides(row.roles as Role[], overrides, "user.manage", "all")) {
      return;
    }
  }

  throw new UserAdminError(
    409,
    "That would leave nobody able to administer users. Give someone else user administration first.",
  );
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Everyone who holds an account. `user.read` is held at `all` by every role —
 * colleagues' names appear on every case — so this is not an administrative
 * endpoint, and deliberately carries no password, override or session detail. */
export async function listUsers(client: Queryable, actor: Actor) {
  requirePermission(actor, "user.read");
  const { rows } = await client.query(
    `${USER_SELECT} group by u.id, p.full_name order by p.full_name`,
  );
  return rows.map(userFromRow);
}

export async function getUser(client: Queryable, actor: Actor, userId: string) {
  requirePermission(actor, "user.read");
  return userFromRow(await loadUserOr404(client, userId));
}

/**
 * One user's overrides and the resulting effective access.
 *
 * Separate from `getUser` because the authorization differs: seeing that a
 * colleague exists and holds the Telecaller role is ordinary, and seeing that
 * someone carved out an exception for them is administration. Requires
 * `permission.override` — the permission that would let you change it.
 *
 * Returns every permission in the catalog with where its answer came from, not
 * just the overridden ones. The business rule this serves is that an override
 * must be VISIBLE as an override: a screen that shows only the final answer
 * would let an exception look like something the role gave them.
 */
export async function getUserPermissions(client: Queryable, actor: Actor, userId: string) {
  requirePermission(actor, "permission.override");
  const user = await loadUserOr404(client, userId);

  const { rows: overrideRows } = await client.query(
    `select o.id, o.permission, o.scope, o.decision, o.granted_by, o.granted_at,
            gp.full_name as granted_by_name
       from user_permission_override o
       left join app_user g on g.id = o.granted_by
       left join person gp on gp.id = g.person_id
      where o.user_id = $1 and o.revoked_at is null
      order by o.permission`,
    [userId],
  );

  const overrides = overrideRows.map((row: Record<string, unknown>) => ({
    id: row.id,
    permission: row.permission,
    scope: row.scope,
    decision: row.decision,
    grantedBy: row.granted_by,
    grantedByName: row.granted_by_name,
    grantedAt: row.granted_at,
  }));

  const effective = effectivePermissionsWithOverrides(
    user.roles as Role[],
    overrides.map((o) => ({
      permission: o.permission as string,
      scope: o.scope as Scope,
      decision: o.decision as "grant" | "deny",
    })),
  );

  return {
    user: userFromRow(user),
    overrides,
    effective: [...effective].map(([permission, status]) => ({ permission, ...status })),
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Create an employee account.
 *
 * An employee is a person first — the same table customers live in (ADR-013:
 * one row per human, whatever their relationship to Amaze).
 *
 * Requires BOTH `user.manage` and `role.assign`, because it does both: an
 * account is created with its roles in one step, so letting `user.manage`
 * alone through would be a way to assign roles without holding the permission
 * for it. At present both are held by the same roles, so this separates
 * nothing today and cannot be got wrong later.
 */
export async function createUser(
  client: Queryable,
  actor: Actor,
  body: Record<string, unknown>,
) {
  requirePermission(actor, "user.manage");
  requirePermission(actor, "role.assign");

  const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const roles = parseRoles(body.roles);

  if (fullName.length === 0) throw new UserAdminError(400, "A user needs a name.");
  if (username.length === 0) throw new UserAdminError(400, "A user needs a username.");
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new UserAdminError(
      400,
      `A password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }

  // Case-insensitively, because login compares case-insensitively (`lower(username)`
  // in api-server.ts). The column's unique index is case-SENSITIVE, so without
  // this check "Tarun" and "tarun" would both be creatable and either could
  // then satisfy a login — two accounts one password attempt can reach.
  const clash = await client.query(`select 1 from app_user where lower(username) = lower($1)`, [
    username,
  ]);
  if (clash.rows[0]) {
    throw new UserAdminError(409, `The username "${username}" is already in use.`);
  }

  const person = await client.query<{ id: string }>(
    `insert into person (full_name, created_by) values ($1, $2) returning id`,
    [fullName, actor.userId],
  );

  const created = await client.query<{ id: string }>(
    `insert into app_user (person_id, auth_identity_id, username, password_hash,
                           is_active, created_by)
     values ($1, $2, $3, $4, true, $5) returning id`,
    [person.rows[0]!.id, randomUUID(), username, await hashPassword(password), actor.userId],
  );
  const userId = created.rows[0]!.id;

  for (const role of roles) {
    await client.query(`insert into user_role (user_id, role, granted_by) values ($1, $2, $3)`, [
      userId,
      role,
      actor.userId,
    ]);
  }

  await recordUserEvent(client, {
    actorUserId: actor.userId,
    subjectUserId: userId,
    eventType: "user.created",
    payloadAfter: { roles, isActive: true },
  });

  return userFromRow(await loadUserOr404(client, userId));
}

/**
 * Replace a user's role assignment outright.
 *
 * Revoke-then-insert rather than delete-then-insert: `user_role` records
 * revocation as a timestamp because a role somebody held last March is part of
 * why a record looks the way it does (0002's column comment). A role that is
 * unchanged is left completely alone, so re-saving the same set does not
 * churn `granted_at` and make everyone look freshly appointed.
 */
export async function setUserRoles(
  client: Queryable,
  actor: Actor,
  userId: string,
  body: Record<string, unknown>,
) {
  requirePermission(actor, "role.assign");
  const existing = await loadUserOr404(client, userId);
  const roles = parseRoles(body.roles);

  const current = new Set(existing.roles as string[]);
  const wanted = new Set<string>(roles);

  for (const role of current) {
    if (!wanted.has(role)) {
      // `revoked_by` as well as `revoked_at`: `user_role_revocation_is_complete`
      // refuses a revocation that does not record who performed it.
      await client.query(
        `update user_role set revoked_at = now(), revoked_by = $1
          where user_id = $2 and role = $3 and revoked_at is null`,
        [actor.userId, userId, role],
      );
    }
  }
  for (const role of wanted) {
    if (!current.has(role)) {
      await client.query(
        `insert into user_role (user_id, role, granted_by) values ($1, $2, $3)`,
        [userId, role, actor.userId],
      );
    }
  }

  await recordUserEvent(client, {
    actorUserId: actor.userId,
    subjectUserId: userId,
    eventType: "user.roles_changed",
    payloadBefore: { roles: [...current] },
    payloadAfter: { roles: [...wanted] },
  });

  await assertAnAdministratorRemains(client);
  return userFromRow(await loadUserOr404(client, userId));
}

/**
 * Activate or deactivate an account.
 *
 * Deactivation is how someone leaves. It bites immediately: `loadActor`
 * refuses an inactive user's existing token on the next request, not at their
 * next login. Nothing here removes or rewrites the rows they touched, so their
 * name survives on every case (BR-062).
 *
 * The self-deactivation guard is carried over from the store verbatim. It is
 * not the same rule as `assertAnAdministratorRemains` — that one stops the
 * office being locked out, this one stops one administrator locking themselves
 * out while others remain, which is a mistake with no upside.
 */
export async function setUserActive(
  client: Queryable,
  actor: Actor,
  userId: string,
  body: Record<string, unknown>,
) {
  requirePermission(actor, "user.manage");
  if (typeof body.isActive !== "boolean") {
    throw new UserAdminError(400, "isActive must be true or false.");
  }
  const isActive = body.isActive;
  const existing = await loadUserOr404(client, userId);

  if (userId === actor.userId && !isActive) {
    throw new UserAdminError(409, "You cannot deactivate your own account.");
  }
  if (existing.is_active === isActive) {
    return userFromRow(existing);
  }

  await client.query(`update app_user set is_active = $1 where id = $2`, [isActive, userId]);

  // Deactivation ends their sessions rather than leaving them to expire. A
  // token outliving the account it belongs to is only refused because
  // `loadActor` re-reads `is_active` on every request — true today, and too
  // load-bearing to be the only thing standing between a departed employee
  // and twelve more hours of access.
  if (!isActive) {
    await client.query(
      `update api_session set revoked_at = now(), revoked_by = $1
        where user_id = $2 and revoked_at is null`,
      [actor.userId, userId],
    );
  }

  await recordUserEvent(client, {
    actorUserId: actor.userId,
    subjectUserId: userId,
    eventType: isActive ? "user.activated" : "user.deactivated",
    payloadBefore: { isActive: existing.is_active },
    payloadAfter: { isActive },
  });

  if (!isActive) await assertAnAdministratorRemains(client);
  return userFromRow(await loadUserOr404(client, userId));
}

/**
 * Set someone else's password — the "they forgot it" path.
 *
 * Existing sessions are revoked. A password reset is usually a response to a
 * suspicion that someone else knows the old one, and leaving their live
 * sessions running would make the reset cosmetic.
 */
export async function resetUserPassword(
  client: Queryable,
  actor: Actor,
  userId: string,
  body: Record<string, unknown>,
) {
  requirePermission(actor, "user.manage");
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new UserAdminError(
      400,
      `A password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  await loadUserOr404(client, userId);

  await client.query(`update app_user set password_hash = $1 where id = $2`, [
    await hashPassword(password),
    userId,
  ]);
  await client.query(
    `update api_session set revoked_at = now(), revoked_by = $1
      where user_id = $2 and revoked_at is null`,
    [actor.userId, userId],
  );

  // No payload. The only fact worth recording is that it happened and who did
  // it; anything about the password itself has no business in a log that is
  // never redacted.
  await recordUserEvent(client, {
    actorUserId: actor.userId,
    subjectUserId: userId,
    eventType: "user.password_reset",
  });

  return { ok: true };
}

/**
 * Change your own password.
 *
 * Needs no permission — it is your account — but does need the current
 * password, so a walk-up at an unlocked PC cannot lock the owner out of it.
 * Other sessions are revoked and the calling one is kept: changing your
 * password should not sign you out of the browser you are sitting at.
 */
export async function changeOwnPassword(
  client: Queryable,
  actor: Actor,
  currentTokenHash: string | null,
  body: Record<string, unknown>,
) {
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new UserAdminError(
      400,
      `A password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }

  const { rows } = await client.query(`select password_hash from app_user where id = $1`, [
    actor.userId,
  ]);
  const stored = rows[0]?.password_hash;
  if (!stored || !(await verifyPassword(currentPassword, stored))) {
    throw new UserAdminError(403, "That is not your current password.");
  }

  await client.query(`update app_user set password_hash = $1 where id = $2`, [
    await hashPassword(newPassword),
    actor.userId,
  ]);
  await client.query(
    `update api_session set revoked_at = now(), revoked_by = $1
      where user_id = $1 and revoked_at is null and token_hash is distinct from $2`,
    [actor.userId, currentTokenHash],
  );

  await recordUserEvent(client, {
    actorUserId: actor.userId,
    subjectUserId: actor.userId,
    eventType: "user.password_changed",
  });

  return { ok: true };
}

/**
 * Grant or deny one permission for one user, on top of their roles.
 *
 * Precedence is NOT decided here. `hasPermissionWithOverrides` owns it — an
 * active deny beats an active grant, which beats the role-derived answer — and
 * this only records the decision. Writing the rule a second time in SQL or in
 * a handler is the drift ADR-022 exists to forbid.
 *
 * Replaces the live decision for that permission if there is one, revoking it
 * first: a person holds one current decision per permission (migration 0032),
 * and the revoked row stays as history.
 */
export async function setOverride(
  client: Queryable,
  actor: Actor,
  userId: string,
  body: Record<string, unknown>,
) {
  requirePermission(actor, "permission.override");
  await loadUserOr404(client, userId);

  const permission = typeof body.permission === "string" ? body.permission : "";
  const scope = typeof body.scope === "string" ? (body.scope as Scope) : ("" as Scope);
  const decision = body.decision === "grant" || body.decision === "deny" ? body.decision : null;

  // The catalog is the authority on which permissions exist and at which
  // scopes each is meaningful. `permission` has a foreign key to the catalog
  // table so an unknown key would fail anyway, but as a 500 out of the driver;
  // and nothing in the schema knows that `user.manage` is `all`-only, so
  // without this a grant could be recorded at `own` and silently never satisfy
  // anything.
  const definition = findPermission(permission);
  if (definition === undefined) {
    throw new UserAdminError(400, `No such permission: ${permission}.`);
  }
  if (decision === null) {
    throw new UserAdminError(400, "A decision must be 'grant' or 'deny'.");
  }
  if (!definition.permittedScopes.includes(scope)) {
    throw new UserAdminError(
      400,
      `${permission} cannot be held at scope "${scope}". Permitted: ${definition.permittedScopes.join(", ")}.`,
    );
  }

  const { rows: previous } = await client.query(
    `select id, scope, decision from user_permission_override
      where user_id = $1 and permission = $2 and revoked_at is null`,
    [userId, permission],
  );
  for (const row of previous) {
    await client.query(
      `update user_permission_override set revoked_at = now(), revoked_by = $1 where id = $2`,
      [actor.userId, row.id],
    );
  }

  const { rows: inserted } = await client.query(
    `insert into user_permission_override (user_id, permission, scope, decision, granted_by)
     values ($1, $2, $3, $4, $5)
     returning id, permission, scope, decision, granted_at`,
    [userId, permission, scope, decision, actor.userId],
  );

  await recordUserEvent(client, {
    actorUserId: actor.userId,
    subjectUserId: userId,
    eventType: decision === "grant" ? "user.permission_granted" : "user.permission_denied",
    payloadBefore: previous[0]
      ? { permission, scope: previous[0].scope, decision: previous[0].decision }
      : null,
    payloadAfter: { permission, scope, decision },
  });

  await assertAnAdministratorRemains(client);

  const row = inserted[0]!;
  return {
    id: row.id,
    permission: row.permission,
    scope: row.scope,
    decision: row.decision,
    grantedAt: row.granted_at,
  };
}

/**
 * Withdraw an override, returning the user to what their roles alone give.
 *
 * Revoked, never deleted — the override was part of why their access looked
 * the way it did while it was live.
 */
export async function revokeOverride(
  client: Queryable,
  actor: Actor,
  userId: string,
  overrideId: string,
) {
  requirePermission(actor, "permission.override");
  await loadUserOr404(client, userId);

  const { rows } = await client.query(
    `select id, permission, scope, decision, revoked_at
       from user_permission_override where id = $1 and user_id = $2`,
    [overrideId, userId],
  );
  const override = rows[0];
  if (!override) throw new UserAdminError(404, "No such override.");
  if (override.revoked_at !== null) {
    throw new UserAdminError(409, "That override has already been revoked.");
  }

  await client.query(
    `update user_permission_override set revoked_at = now(), revoked_by = $1 where id = $2`,
    [actor.userId, overrideId],
  );

  await recordUserEvent(client, {
    actorUserId: actor.userId,
    subjectUserId: userId,
    eventType: "user.permission_override_revoked",
    payloadBefore: {
      permission: override.permission,
      scope: override.scope,
      decision: override.decision,
    },
  });

  await assertAnAdministratorRemains(client);
  return { ok: true };
}
