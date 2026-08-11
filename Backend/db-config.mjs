/**
 * Database connection settings, read from the environment only.
 *
 * Pulled out of `migrate.mjs` because that file is also a CLI entry point:
 * merely importing it (as `backup.mjs` and `restore.mjs` used to, just to
 * reach `connectionConfig()`) ran its top-level `main()` as a side effect,
 * silently applying every pending migration. A module that only ever reads
 * `process.env` cannot have that problem, so it lives on its own here.
 */

import { loadDotEnv } from "./env.mjs";

loadDotEnv();

export function connectionConfig() {
  return {
    host: process.env.AOS_DB_HOST ?? "127.0.0.1",
    port: Number(process.env.AOS_DB_PORT ?? 5432),
    database: process.env.AOS_DB_NAME ?? "aos",
    user: process.env.AOS_DB_USER ?? "postgres",
    password: process.env.AOS_DB_PASSWORD ?? "",
  };
}
