/**
 * Regression test for the backup-triggers-migrations defect.
 *
 * `backup.mjs` used to import `connectionConfig` from `migrate.mjs`, and
 * `migrate.mjs` ran its migration runner as a top-level side effect of being
 * imported — so a plain `npm run backup` silently applied every pending
 * migration to whatever database `.env` pointed at. This proves both halves
 * of the fix: importing the migration module (or the config module
 * `backup.mjs`/`restore.mjs` now use) touches no database at all, and a
 * migration that was pending before the import is still pending after it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

// A dedicated throwaway database, separate from `aos_test` (shared by the
// rest of the integration suite), so this test can assert on an empty
// migration ledger without racing anything else.
const TEST_DB = "aos_test_migrate_side_effect";

async function adminClient() {
  const client = new pg.Client({
    host: process.env.AOS_DB_HOST ?? "127.0.0.1",
    port: Number(process.env.AOS_DB_PORT ?? 5432),
    database: "postgres",
    user: process.env.AOS_DB_USER ?? "postgres",
    password: process.env.AOS_DB_PASSWORD ?? "",
  });
  await client.connect();
  return client;
}

beforeAll(async () => {
  const admin = await adminClient();
  try {
    await admin.query(`drop database if exists "${TEST_DB}"`);
    await admin.query(`create database "${TEST_DB}"`);
  } finally {
    await admin.end();
  }
});

afterAll(async () => {
  const admin = await adminClient();
  try {
    await admin.query(`drop database if exists "${TEST_DB}"`);
  } finally {
    await admin.end();
  }
});

async function schemaMigrationsRowCount(): Promise<number> {
  const client = new pg.Client({
    host: process.env.AOS_DB_HOST ?? "127.0.0.1",
    port: Number(process.env.AOS_DB_PORT ?? 5432),
    database: TEST_DB,
    user: process.env.AOS_DB_USER ?? "postgres",
    password: process.env.AOS_DB_PASSWORD ?? "",
  });
  await client.connect();
  try {
    const { rows } = await client.query(
      "select to_regclass('public.schema_migrations') is not null as exists",
    );
    if (!rows[0].exists) return 0;
    const result = await client.query("select count(*)::int as n from public.schema_migrations");
    return result.rows[0].n;
  } finally {
    await client.end();
  }
}

describe("importing the migration module has no side effects", () => {
  it("does not apply pending migrations merely by being imported", async () => {
    // A fresh database has never had a migration applied to it — every
    // migration is pending. This is the failure mode the bug produced.
    expect(await schemaMigrationsRowCount()).toBe(0);

    const previousDbName = process.env.AOS_DB_NAME;
    process.env.AOS_DB_NAME = TEST_DB;
    try {
      // What backup.mjs and restore.mjs do: import the config helper.
      const dbConfig = await import("./db-config.mjs");
      expect(dbConfig.connectionConfig().database).toBe(TEST_DB);

      // Importing migrate.mjs itself — the module that used to run its CLI
      // main() as an import side effect — must also be inert.
      const migrate = await import("./migrate.mjs");
      expect(typeof migrate.connectionConfig).toBe("function");
    } finally {
      if (previousDbName === undefined) delete process.env.AOS_DB_NAME;
      else process.env.AOS_DB_NAME = previousDbName;
    }

    // The pending migration must still be pending: nothing ran.
    expect(await schemaMigrationsRowCount()).toBe(0);
  });
});
