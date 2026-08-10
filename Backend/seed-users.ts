#!/usr/bin/env node
/**
 * Create the five AOS development accounts.
 *
 * WHY THIS EXISTS: authentication is server-side, which creates a bootstrap
 * problem every such system has — you cannot log in to create the first user.
 * This is that first step for a DEVELOPMENT database, and it is what puts the
 * five roles on the board that the Stage 2 acceptance test exercises. The
 * office equivalent is `bootstrap-production.ts`, which creates the six real
 * employees and disables everything this script made.
 *
 * WHAT CHANGED IN STAGE 4 ITEM 3, and why it needed to.
 *
 * This script used to hash `process.env.AOS_SEED_PASSWORD ?? "aos-dev-password"`
 * — a literal, committed to a public repository, applied to five accounts, one
 * of which (`partner.p`) holds `managing_partner`, the widest role AOS has. It
 * had a comment saying the password was not a secret and must not become one.
 * That comment was correct about the intent and had no way to enforce it, and
 * two things made the intent fail on its own terms:
 *
 *   - There was NO database guard at all. `bootstrap-production.ts` refuses a
 *     database whose name looks like a test one; this script, the one that
 *     writes a published credential, would run against anything it was pointed
 *     at. `npm run seed-users` against the office database was one command and
 *     silently created five working logins. So was a freshly restored copy of
 *     it, and so was any database where somebody had removed those rows rather
 *     than deactivating them.
 *
 *   - The published constant was the DEFAULT. Getting it wrong required doing
 *     nothing; avoiding it required knowing to set an environment variable.
 *
 * Both are inverted now. There is no password in this file: absent an explicit
 * AOS_SEED_PASSWORD, one is generated and printed once. And the script asks
 * the database whether it looks like production before writing anything.
 *
 * Still idempotent, and that is still the important safety property: an
 * existing username is left completely alone, password included, ACTIVE FLAG
 * INCLUDED. Running this after `bootstrap-production` has disabled the dev
 * accounts does not bring them back.
 */

import { randomBytes, randomUUID } from "node:crypto";

import { hashPassword } from "@domain/auth/password.js";
import type { Role } from "@domain/permissions/index.js";

// The ADMIN pool, not the application's: `aos_app` is deliberately unable to
// create accounts (see db.ts). Falls back to the ordinary pool when
// AOS_DB_ADMIN_USER is unset, so nothing changes on a machine still connecting
// as `postgres`.
import { adminPool, closeAdminPool, withAdmin } from "./db.js";

const EMPLOYEES: readonly { username: string; fullName: string; role: Role }[] = [
  { username: "telecaller.a", fullName: "Telecaller A", role: "telecaller" },
  { username: "telecaller.b", fullName: "Telecaller B", role: "telecaller" },
  { username: "login.exec", fullName: "Login Executive", role: "login_executive" },
  { username: "manager.m", fullName: "Manager M", role: "manager" },
  { username: "partner.p", fullName: "Managing Partner P", role: "managing_partner" },
];

/**
 * The real Amaze Loans employees, from `bootstrap-production.ts`.
 *
 * Duplicated deliberately rather than imported: importing would make this
 * script depend on the production bootstrap, and the coupling that matters
 * runs the other way. The list is the STRONGEST available signal that a
 * database is the office one — far better than its name, since the office
 * database is called `aos` and so is every developer's.
 */
const PRODUCTION_USERNAMES = [
  "chinna",
  "jayalakshmi",
  "tarun",
  "sasirekha",
  "ismail",
  "keerthivhasan",
];

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/**
 * A password nobody has published, for when the caller did not supply one.
 *
 * Printed once and recoverable only by resetting it — which is the correct
 * trade for a development account and is what `bootstrap-production.ts`
 * already does for the real ones. A developer who wants a stable password
 * across rebuilds sets AOS_SEED_PASSWORD in `.env`, which is git-ignored;
 * that is the supported way to have a memorable one, and it keeps the value
 * out of the repository where the old default sat.
 */
function generatePassword(): string {
  return `dev-${randomBytes(9).toString("base64url")}`;
}

async function main(): Promise<void> {
  const database = process.env.AOS_DB_NAME ?? "aos";
  const confirmed = process.env.AOS_SEED_CONFIRM === database;

  // ── Guard 1: does this database already hold the real employees? ──────────
  //
  // Checked before anything is written, and NOT overridable by
  // AOS_SEED_CONFIRM. A name can be typed by accident; six named people
  // cannot. If they are here, this is the office database or a restore of it,
  // and no combination of flags should put a development login on it.
  const { rows: production } = await adminPool().query(
    `select username from app_user where lower(username) = any($1::text[])`,
    [PRODUCTION_USERNAMES],
  );
  if (production.length > 0) {
    await closeAdminPool();
    fail(
      `Refusing to run: "${database}" holds real employee accounts ` +
        `(${production.map((r: { username: string }) => r.username).join(", ")}).\n` +
        `  This is the office database, or a restore of it. Development accounts do not\n` +
        `  belong on it — see Backend/bootstrap-production.ts.`,
    );
  }

  // ── Guard 2: is the name obviously a development one? ────────────────────
  //
  // `aos_test`, `aos_e2e`, `aos_dev`, `aos_local`, `aos_scratch` pass silently
  // — that is the whole integration and E2E fleet, so no test workflow gains a
  // step. Anything else, INCLUDING the bare `aos` a developer uses on their own
  // machine, needs AOS_SEED_CONFIRM. That is deliberate: `aos` is also the
  // office database's name, and this script cannot tell the two apart from the
  // outside. One environment variable, once, is the cost of that ambiguity.
  const looksLikeDevelopment = /_(test|e2e|dev|local|scratch)$/i.test(database);
  if (!looksLikeDevelopment && !confirmed) {
    await closeAdminPool();
    fail(
      `Refusing to run against "${database}": that name is not obviously a development\n` +
        `  database, and this script creates accounts with a shared password.\n\n` +
        `  If "${database}" really is your own development database:\n` +
        `      AOS_SEED_CONFIRM=${database} npm run seed-users\n\n` +
        `  If you meant the office database, you want bootstrap-production instead.`,
    );
  }

  const supplied = process.env.AOS_SEED_PASSWORD;
  const password = supplied ?? generatePassword();
  const passwordHash = await hashPassword(password);
  const created: string[] = [];

  await withAdmin(async (client) => {
    for (const employee of EMPLOYEES) {
      // Case-insensitively, because login compares that way. A `Telecaller.A`
      // and a `telecaller.a` would otherwise both exist and either could
      // satisfy one password attempt.
      const existing = await client.query(
        `select id from app_user where lower(username) = lower($1)`,
        [employee.username],
      );
      if (existing.rows[0]) {
        // Including deactivated ones. `bootstrap-production` disables these
        // accounts; re-running this script must not undo that.
        console.log(`  exists   ${employee.username}`);
        continue;
      }

      // An employee is a person first — the same table customers live in
      // (ADR-013: one row per human, whatever their relationship to Amaze).
      const person = await client.query<{ id: string }>(
        `insert into person (full_name) values ($1) returning id`,
        [employee.fullName],
      );
      const personId = person.rows[0]!.id;

      const user = await client.query<{ id: string }>(
        `insert into app_user (person_id, auth_identity_id, username, password_hash, is_active)
         values ($1, $2, $3, $4, true) returning id`,
        [personId, randomUUID(), employee.username, passwordHash],
      );
      const userId = user.rows[0]!.id;

      await client.query(
        `insert into user_role (user_id, role, granted_by) values ($1, $2, $1)`,
        [userId, employee.role],
      );

      created.push(employee.username);
      console.log(`  created  ${employee.username.padEnd(14)} ${employee.role}`);
    }
  });

  await closeAdminPool();

  if (created.length === 0) {
    console.log(`\nNothing to do — every development account already exists.`);
    return;
  }

  if (supplied) {
    console.log(`\nDone. ${created.length} account(s) created with AOS_SEED_PASSWORD.`);
  } else {
    console.log(
      `\n${"=".repeat(64)}\n` +
        `  PASSWORD FOR THE ${created.length} NEW ACCOUNT(S) — SHOWN ONCE\n\n` +
        `      ${password}\n\n` +
        `  Generated, not published: nothing in this repository contains it.\n` +
        `  Set AOS_SEED_PASSWORD in .env (git-ignored) if you would rather\n` +
        `  choose a stable one for this machine.\n` +
        `${"=".repeat(64)}\n`,
    );
  }
}

await main();
