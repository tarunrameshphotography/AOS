#!/usr/bin/env node
/**
 * Stand up the real Amaze Loans accounts, and clear the throwaway ones.
 *
 * WHY THIS IS NOT `seed-users.ts`: that script exists to make a development
 * database usable and says so — every account it creates shares one password
 * that is written down in the file. It is exactly right for a machine with no
 * customer data on it and exactly wrong for the office. This script is the
 * other half: six named employees, one independently generated password each,
 * printed once and never stored anywhere but the hash.
 *
 * IT IS DELIBERATELY AWKWARD TO RUN. Creating accounts that will hold real
 * customer files, and deleting the seed accounts that will not, are both
 * one-way enough that a mistyped command should not be able to do either.
 * Hence:
 *
 *   - It refuses to run against a database whose name looks like a test one.
 *   - `--reset` is required to remove anything, and additionally requires
 *     AOS_BOOTSTRAP_CONFIRM to equal the database name, so the destructive
 *     path cannot be reached by pressing up-arrow and enter.
 *   - It is idempotent: an employee who already has an account is left
 *     entirely alone, password included. Re-running never resets a password
 *     somebody is already using.
 *
 * Usage:
 *   npm run bootstrap-production                 # create the six accounts
 *   npm run bootstrap-production -- --reset      # …and clear the dev seed data
 *   npm run bootstrap-production -- --dry-run    # say what it would do
 */

import { randomUUID, randomInt } from "node:crypto";

import { hashPassword } from "@domain/auth/password.js";
import type { Role } from "@domain/permissions/index.js";

import { pool, withActor } from "./db.js";

/**
 * The six people who work at Amaze Loans, and what they do.
 *
 * Manager and Managing Partner currently resolve to the same grants
 * (`MANAGING_PARTNER_GRANTS` in src/domain/permissions/roles.ts) — the roles
 * are recorded distinctly here anyway, because the day the business wants them
 * to differ, the data should already say who is which.
 */
const EMPLOYEES: readonly { username: string; fullName: string; roles: Role[] }[] = [
  { username: "chinna", fullName: "Chinna Thambi", roles: ["telecaller", "login_executive"] },
  { username: "jayalakshmi", fullName: "Jayalakshmi", roles: ["telecaller"] },
  { username: "tarun", fullName: "Tarun Ramesh", roles: ["manager"] },
  { username: "sasirekha", fullName: "C Sasi Rekha", roles: ["managing_partner"] },
  { username: "ismail", fullName: "Mohammed Ismail", roles: ["managing_partner"] },
  { username: "keerthivhasan", fullName: "V Keerthivhasan", roles: ["managing_partner"] },
];

/**
 * Development accounts from `seed-users.ts`, by username.
 *
 * These share one published password. Every one of them is a way into the
 * office database for anyone who has read the repository, so `--reset`
 * deactivates them. Deactivated rather than deleted: `app_user` is referenced
 * from a dozen tables and BR-062 wants the name to survive anyway.
 */
const DEV_SEED_USERNAMES = [
  "telecaller.a",
  "telecaller.b",
  "login.exec",
  "manager.m",
  "partner.p",
];

/**
 * A password a person has to type, generated rather than chosen.
 *
 * Four words and a number: long enough that PBKDF2 makes brute force
 * irrelevant, and typeable by someone reading it off a slip of paper, which is
 * how these will actually be delivered. No ambiguous word pairs and no
 * punctuation to mis-transcribe.
 */
const WORDS = [
  "amber", "harbour", "lantern", "marble", "orchard", "pebble", "quartz", "ribbon",
  "saffron", "thicket", "umbrella", "velvet", "walnut", "yonder", "zephyr", "anchor",
  "bracket", "cinder", "dapple", "ember", "fathom", "granite", "hollow", "ivory",
  "juniper", "kettle", "linen", "meadow", "nutmeg", "opal", "parcel", "rustic",
];

function generatePassword(): string {
  const words = Array.from({ length: 4 }, () => WORDS[randomInt(WORDS.length)]);
  return `${words.join("-")}-${randomInt(10, 100)}`;
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const reset = args.has("--reset");
  const dryRun = args.has("--dry-run");
  const database = process.env.AOS_DB_NAME ?? "aos";

  // A suite that truncates tables must never be one typo away from the real
  // data — and neither must this, in the other direction.
  if (/test/i.test(database)) {
    fail(`Refusing to run against "${database}": that looks like a test database.`);
  }

  if (reset && !dryRun && process.env.AOS_BOOTSTRAP_CONFIRM !== database) {
    fail(
      `--reset deactivates the development seed accounts in "${database}".\n` +
        `  Re-run with AOS_BOOTSTRAP_CONFIRM=${database} if that is what you want.`,
    );
  }

  console.log(`\nAOS production bootstrap — database "${database}"${dryRun ? " (dry run)" : ""}\n`);

  const issued: { fullName: string; username: string; password: string }[] = [];

  await withActor(null, async (client) => {
    for (const employee of EMPLOYEES) {
      const existing = await client.query(
        `select id, is_active from app_user where lower(username) = lower($1)`,
        [employee.username],
      );
      if (existing.rows[0]) {
        console.log(`  exists    ${employee.username.padEnd(14)} ${employee.fullName}`);
        continue;
      }
      if (dryRun) {
        console.log(`  would add ${employee.username.padEnd(14)} ${employee.fullName}`);
        continue;
      }

      const password = generatePassword();

      // An employee is a person first — the same table customers live in
      // (ADR-013: one row per human, whatever their relationship to Amaze).
      const person = await client.query<{ id: string }>(
        `insert into person (full_name) values ($1) returning id`,
        [employee.fullName],
      );
      const user = await client.query<{ id: string }>(
        `insert into app_user (person_id, auth_identity_id, username, password_hash, is_active)
         values ($1, $2, $3, $4, true) returning id`,
        [person.rows[0]!.id, randomUUID(), employee.username, await hashPassword(password)],
      );
      const userId = user.rows[0]!.id;

      for (const role of employee.roles) {
        // `granted_by` is the account itself: nobody granted these, the
        // bootstrap did, and pointing at a fictitious grantor would be worse.
        await client.query(
          `insert into user_role (user_id, role, granted_by) values ($1, $2, $1)`,
          [userId, role],
        );
      }

      // The bootstrap is not a signed-in employee, so the event names the
      // system rather than a user — which is what `actor_kind` is for
      // (BR-052).
      await client.query(
        `insert into event (actor_kind, entity_type, entity_id, event_type, payload_after, source)
         values ('system', 'app_user', $1, 'user.created', $2, 'automation')`,
        [userId, JSON.stringify({ roles: employee.roles, isActive: true })],
      );

      issued.push({ fullName: employee.fullName, username: employee.username, password });
      console.log(`  created   ${employee.username.padEnd(14)} ${employee.roles.join(" + ")}`);
    }

    if (reset) {
      console.log("");
      for (const username of DEV_SEED_USERNAMES) {
        const { rows } = await client.query(
          `select id from app_user where username = $1 and is_active`,
          [username],
        );
        if (!rows[0]) continue;
        if (dryRun) {
          console.log(`  would deactivate ${username}`);
          continue;
        }

        await client.query(`update app_user set is_active = false where id = $1`, [rows[0].id]);
        await client.query(
          `update api_session set revoked_at = now() where user_id = $1 and revoked_at is null`,
          [rows[0].id],
        );
        await client.query(
          `insert into event (actor_kind, entity_type, entity_id, event_type, payload_after, source)
           values ('system', 'app_user', $1, 'user.deactivated', $2, 'automation')`,
          [rows[0].id, JSON.stringify({ isActive: false, reason: "development_seed_account" })],
        );
        console.log(`  disabled  ${username}`);
      }
    }
  });

  if (issued.length > 0) {
    console.log(
      `\n${"=".repeat(64)}\n` +
        `  PASSWORDS — SHOWN ONCE. They are stored only as PBKDF2 hashes and\n` +
        `  cannot be recovered. Give each person theirs directly, then have\n` +
        `  them change it (POST /api/auth/password) and destroy the note.\n` +
        `${"=".repeat(64)}\n`,
    );
    for (const account of issued) {
      console.log(`  ${account.fullName.padEnd(18)} ${account.username.padEnd(14)} ${account.password}`);
    }
    console.log("");
  }

  if (!reset) {
    console.log(
      `\n  The development seed accounts from seed-users.ts share one published\n` +
        `  password and are still active. Re-run with --reset to disable them\n` +
        `  before this database holds real customer files.\n`,
    );
  }

  await pool.end();
}

await main();
