/**
 * Integration-test bootstrap.
 *
 * Creates a throwaway database and runs the real migrations into it, so the
 * suite exercises the actual schema rather than a hand-built approximation of
 * it. A test that passes against a mock of the persistence layer says nothing
 * about whether the persistence layer works, which is the whole question
 * Stage 2 is asking.
 *
 * It is a SEPARATE database (`aos_test`) from the office one (`aos`) — a suite
 * that truncates tables must never be one connection-string typo away from the
 * real customer data.
 */

import { spawnSync } from "node:child_process";
import pg from "pg";

import { loadDotEnv } from "./env.mjs";

loadDotEnv();

/**
 * Hard-coded, deliberately NOT read from the environment.
 *
 * globalSetup runs in vitest's main process, which does not receive
 * `test.env` — so reading AOS_DB_NAME here would pick up `.env` and point the
 * whole suite at the OFFICE database. It did exactly that on the first run.
 * The name must match `vitest.integration.config.ts`.
 */
const TEST_DB = "aos_test";

export async function setup(): Promise<void> {
  // Creating a database needs CREATEDB, which `aos_app` (migration 0033) does
  // not have and must not have — same admin-fallback reasoning as
  // `Backend/db-config.mjs`'s `connectionConfig()`: prefer
  // `AOS_DB_ADMIN_USER`/`_PASSWORD` when the machine's `.env` set them (an
  // office server past Docs/Installation.md §5a), else fall back to
  // `AOS_DB_USER`/`_PASSWORD` (a plain dev machine, still `postgres`).
  const adminUser = process.env.AOS_DB_ADMIN_USER?.trim();
  const admin = new pg.Client({
    host: process.env.AOS_DB_HOST ?? "127.0.0.1",
    port: Number(process.env.AOS_DB_PORT ?? 5432),
    database: "postgres",
    user: adminUser || process.env.AOS_DB_USER || "postgres",
    password: adminUser
      ? (process.env.AOS_DB_ADMIN_PASSWORD ?? "")
      : (process.env.AOS_DB_PASSWORD ?? ""),
  });

  await admin.connect();
  try {
    const { rows } = await admin.query("select 1 from pg_database where datname = $1", [
      TEST_DB,
    ]);
    if (rows.length === 0) {
      // Not parameterisable — CREATE DATABASE takes an identifier, not a
      // value. TEST_DB is the constant above, never anything from a request.
      await admin.query(`create database "${TEST_DB}"`);
    }
  } finally {
    await admin.end();
  }

  const result = spawnSync(process.execPath, ["Backend/migrate.mjs"], {
    env: { ...process.env, AOS_DB_NAME: TEST_DB },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `Migrations failed against ${TEST_DB}:\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
}
