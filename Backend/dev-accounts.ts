/**
 * The development seed accounts, and how production gets rid of them.
 *
 * WHY THIS IS ITS OWN MODULE. The list and the disabling logic belong to
 * `bootstrap-production.ts` conceptually, and lived there until Stage 4 Item 3.
 * They had to move for a mundane reason: that file runs `await main()` at the
 * top level, so importing it — which the security test must do, to assert that
 * production bootstrap leaves no development credential able to authenticate —
 * would execute a production bootstrap as a side effect of a test collecting
 * its imports. A module with no top-level effects is the fix.
 *
 * `seed-users.ts` creates these five; `bootstrap-production.ts` disables them
 * on every run. Both halves of that contract now name the same constant, which
 * they did not before: a sixth development account added to the seeder and not
 * to the disable list would have been created and then left active.
 */

import type pg from "pg";

/**
 * The five accounts `Backend/seed-users.ts` creates.
 *
 * Historically these shared one password written down in that file, which made
 * every one of them a way into the office database for anyone who had read the
 * repository — `partner.p` most of all, since `managing_partner` is the widest
 * role AOS has. `seed-users.ts` no longer publishes a password, but any
 * database seeded before that change still holds accounts that do, and nothing
 * can tell the difference from the outside. So production disables all five,
 * always.
 */
export const DEV_SEED_USERNAMES = [
  "telecaller.a",
  "telecaller.b",
  "login.exec",
  "manager.m",
  "partner.p",
] as const;

/**
 * Disable every development seed account. Returns the ones it actually changed.
 *
 * Deactivation, never deletion (BR-003, BR-062): `is_active` goes false, live
 * sessions are revoked so nothing survives on a token that was issued before
 * the run, the row and every reference to it stay, and one UPDATE reverses the
 * whole thing. That reversibility is why this is unconditional rather than
 * sitting behind the double confirmation `bootstrap-production.ts` used to
 * require — the confirmation was guarding an operation that was never
 * destructive, while the genuinely dangerous state (five published logins on a
 * database holding real customer files) was the default.
 */
export async function disableDevelopmentAccounts(
  client: Pick<pg.PoolClient, "query">,
  options: { dryRun?: boolean; log?: (line: string) => void } = {},
): Promise<string[]> {
  const log = options.log ?? (() => {});
  const disabled: string[] = [];

  for (const username of DEV_SEED_USERNAMES) {
    // Case-insensitively, because login compares that way (`lower(username)`
    // in api-server.ts) and a `Telecaller.A` created by hand would otherwise
    // survive a run that reported success.
    const { rows } = await client.query(
      `select id from app_user where lower(username) = lower($1) and is_active`,
      [username],
    );
    if (!rows[0]) continue;
    if (options.dryRun) {
      log(`  would disable ${username}`);
      continue;
    }

    await client.query(`update app_user set is_active = false where id = $1`, [rows[0].id]);
    // Deactivation alone would leave any live token working for up to twelve
    // more hours everywhere except loadActor's is_active re-read. Revoking is
    // what makes "disabled" mean disabled now.
    await client.query(
      `update api_session set revoked_at = now() where user_id = $1 and revoked_at is null`,
      [rows[0].id],
    );
    // The bootstrap is not a signed-in employee, so the event names the system
    // rather than a user — which is what `actor_kind` is for (BR-052).
    await client.query(
      `insert into event (actor_kind, entity_type, entity_id, event_type, payload_after, source)
       values ('system', 'app_user', $1, 'user.deactivated', $2, 'automation')`,
      [rows[0].id, JSON.stringify({ isActive: false, reason: "development_seed_account" })],
    );

    disabled.push(username);
    log(`  disabled  ${username}`);
  }

  return disabled;
}
