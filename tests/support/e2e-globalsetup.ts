/**
 * Playwright bootstrap — a database of its own, and the accounts to sign in with.
 *
 * WHY A SEPARATE DATABASE: the browser suite creates customers and cases for
 * real now. Pointed at `aos` it would fill the office database with test
 * records; pointed at `aos_test` it would race the vitest integration suite,
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
import type { Role } from "../../src/domain/permissions/index.js";

// Playwright's config process does not inherit the app's environment, so the
// connection details have to be read the same way the backend reads them.
loadDotEnv();

export const E2E_DB = "aos_e2e";
export const E2E_PASSWORD = "e2e-test-password";

/** The accounts the specs sign in as. One Telecaller is not enough: proving
 * that a colleague's case is invisible needs a second one. */
export const E2E_USERS: readonly { username: string; fullName: string; roles: Role[] }[] = [
  { username: "e2e.telecaller", fullName: "E2E Telecaller", roles: ["telecaller"] },
  { username: "e2e.telecaller2", fullName: "E2E Second Telecaller", roles: ["telecaller"] },
  { username: "e2e.loginexec", fullName: "E2E Login Executive", roles: ["login_executive"] },
  { username: "e2e.manager", fullName: "E2E Manager", roles: ["manager"] },
  { username: "e2e.partner", fullName: "E2E Managing Partner", roles: ["managing_partner"] },
];

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
      // Idempotent: a re-run reuses the accounts rather than colliding on the
      // username unique index.
      const existing = await db.query(`select id from app_user where username = $1`, [
        user.username,
      ]);
      if (existing.rows[0]) continue;

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
  } finally {
    await db.end();
  }
}
