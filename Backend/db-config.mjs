/**
 * Database connection settings, read from the environment only.
 *
 * Pulled out of `migrate.mjs` because that file is also a CLI entry point:
 * merely importing it (as `backup.mjs` and `restore.mjs` used to, just to
 * reach `connectionConfig()`) ran its top-level `main()` as a side effect,
 * silently applying every pending migration. A module that only ever reads
 * `process.env` cannot have that problem, so it lives on its own here.
 *
 * ADMIN FALLBACK, same reasoning as `Backend/db.ts`'s `adminPool()`: migrating
 * the schema, dumping every table for a backup, and restoring a dump are an
 * owner's job, not the running application's — `aos_app` (migration 0033) has
 * no grant on `schema_migrations` and no `LOCK`/`SELECT` broad enough for
 * `pg_dump` to lock the whole database, by design. If `AOS_DB_ADMIN_USER` is
 * set, these scripts use it; if not, they fall back to `AOS_DB_USER`, which is
 * what happens on a machine still connecting as `postgres`.
 */

import { loadDotEnv } from "./env.mjs";

loadDotEnv();

export function connectionConfig() {
  const adminUser = process.env.AOS_DB_ADMIN_USER?.trim();
  return {
    host: process.env.AOS_DB_HOST ?? "127.0.0.1",
    port: Number(process.env.AOS_DB_PORT ?? 5432),
    database: process.env.AOS_DB_NAME ?? "aos",
    user: adminUser || process.env.AOS_DB_USER || "postgres",
    password: adminUser
      ? (process.env.AOS_DB_ADMIN_PASSWORD ?? "")
      : (process.env.AOS_DB_PASSWORD ?? ""),
  };
}
