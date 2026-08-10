/**
 * Playwright bootstrap — a database of its own, and the accounts to sign in with.
 *
 * WHY A SEPARATE DATABASE: the browser suite creates customers and cases for
 * real, and as of Stage 3C-0 it also creates employees, assigns roles, resets
 * passwords and deactivates accounts. Pointed at `aos` it would administer the
 * office; pointed at `aos_test` it would race the vitest integration suite,
 * which truncates and reseeds. `aos_e2e` belongs to this suite alone.
 *
 * WHY IT SEEDS ITS OWN USERS: authentication is server-side as of Stage 3B, so
 * "log in as a Telecaller" means a row in `app_user` with a password hash. The
 * prototype's `seed.ts` employees lived in localStorage and cannot be signed
 * in to any more.
 *
 * The password here is a test credential and nothing else. It never reaches
 * the office database, which is a different database with different accounts —
 * see `Backend/bootstrap-production.ts` for how those are made.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { loadDotEnv } from "../../Backend/env.mjs";
import { hashPassword } from "../../src/domain/auth/password.js";
import { E2E_DB, E2E_PASSWORD, E2E_USERS, assertNotOfficeDatabase } from "./e2e-environment.js";

// Playwright's config process does not inherit the app's environment, so the
// connection details have to be read the same way the backend reads them.
loadDotEnv();

export { E2E_DB, E2E_PASSWORD, E2E_USERS };

function connection(database: string): pg.Client {
  return new pg.Client({
    host: process.env.AOS_DB_HOST ?? "127.0.0.1",
    port: Number(process.env.AOS_DB_PORT ?? 5432),
    database,
    user: process.env.AOS_DB_USER ?? "postgres",
    password: process.env.AOS_DB_PASSWORD ?? "",
  });
}

export default async function globalSetup(): Promise<void> {
  // Before anything is created, migrated or inserted. Everything below this
  // line writes, and the office database must never be what it writes to.
  assertNotOfficeDatabase(E2E_DB);

  const admin = connection("postgres");
  await admin.connect();
  try {
    const { rows } = await admin.query("select 1 from pg_database where datname = $1", [E2E_DB]);
    if (rows.length === 0) {
      // Not parameterisable — CREATE DATABASE takes an identifier, not a
      // value. E2E_DB is the constant above, never anything from a test.
      await admin.query(`create database "${E2E_DB}"`);
    }
  } finally {
    await admin.end();
  }

  const migrated = spawnSync(process.execPath, ["Backend/migrate.mjs"], {
    env: { ...process.env, AOS_DB_NAME: E2E_DB },
    encoding: "utf8",
  });
  if (migrated.status !== 0) {
    throw new Error(
      `Migrations failed against ${E2E_DB}:\n${migrated.stdout ?? ""}${migrated.stderr ?? ""}`,
    );
  }

  const db = connection(E2E_DB);
  await db.connect();
  try {
    const passwordHash = await hashPassword(E2E_PASSWORD);
    for (const user of E2E_USERS) {
      // Idempotent, and self-repairing: a previous run may have deactivated an
      // account or changed its password on purpose (the User Management specs
      // do both). Left as they were, the next run would fail at sign-in with
      // an error that says nothing about why.
      const existing = await db.query<{ id: string }>(
        `select id from app_user where username = $1`,
        [user.username],
      );
      if (existing.rows[0]) {
        await db.query(
          `update app_user set is_active = true, password_hash = $1 where id = $2`,
          [passwordHash, existing.rows[0].id],
        );
        for (const role of user.roles) {
          await db.query(
            `insert into user_role (user_id, role, granted_by)
             select $1, $2, $1
              where not exists (select 1 from user_role
                                 where user_id = $1 and role = $2 and revoked_at is null)`,
            [existing.rows[0].id, role],
          );
        }
        // A run that granted or denied an override to one of these accounts
        // must not change what the next run's assertions mean.
        await db.query(
          `update user_permission_override set revoked_at = now(), revoked_by = user_id
            where user_id = $1 and revoked_at is null`,
          [existing.rows[0].id],
        );
        continue;
      }

      const person = await db.query<{ id: string }>(
        `insert into person (full_name) values ($1) returning id`,
        [user.fullName],
      );
      const created = await db.query<{ id: string }>(
        `insert into app_user (person_id, auth_identity_id, username, password_hash, is_active)
         values ($1, $2, $3, $4, true) returning id`,
        [person.rows[0]!.id, randomUUID(), user.username, passwordHash],
      );
      for (const role of user.roles) {
        await db.query(`insert into user_role (user_id, role, granted_by) values ($1, $2, $1)`, [
          created.rows[0]!.id,
          role,
        ]);
      }
    }

    // The accounts the User Management specs create are NOT cleaned up here.
    // They are given a run-unique username by the spec and deactivated by it
    // when it is finished with them, which is the only cleanup the product
    // supports: there is no delete, deliberately (BR-062, and the note at the
    // top of Backend/users.ts). Deleting them behind the API's back would test
    // a path the office will never take.
  } finally {
    await db.end();
  }
}
