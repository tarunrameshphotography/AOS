#!/usr/bin/env node
/**
 * Migration runner for the AOS schema.
 *
 * WHY THIS EXISTS NOW: `Database/README.md` has said from the beginning that
 * "nothing here has been executed" — thirty migrations written, checked by
 * reading, never once parsed by Postgres. Standing them up is the first task
 * of the Persistence milestone, because every judgement about the schema is
 * worth nothing until the SQL has actually run.
 *
 * WHY THE WHOLE FILE IS ONE QUERY: a migration is sent to Postgres verbatim,
 * never split on semicolons. `0010_security_defaults.sql` defines
 * `app.has_permission()` with a `$$ ... $$` body containing semicolons, and
 * naive splitting would tear it in half — a class of bug that only appears
 * once a function body grows a statement, i.e. long after the splitter looked
 * correct. node-postgres sends a multi-statement string as one simple query,
 * which is exactly what is wanted.
 *
 * WHY A CHECKSUM AND NOT JUST A FILENAME: an applied migration that is later
 * edited is the quietest way to make two installations disagree about their
 * own schema. The office database and a developer's would both report
 * "0024 applied" while holding different tables. Recording the sha256 turns
 * that into a loud failure at the next run instead of a silent divergence.
 *
 * Usage:
 *   node Backend/migrate.mjs            apply every pending migration
 *   node Backend/migrate.mjs --status   list applied/pending, change nothing
 */

import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadDotEnv } from "./env.mjs";

loadDotEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "Database", "migrations");

/**
 * Connection settings come from the environment only. No connection string is
 * ever committed (see `.env.example`), and nothing here is prefixed VITE_, so
 * none of it can reach the browser bundle.
 */
export function connectionConfig() {
  return {
    host: process.env.AOS_DB_HOST ?? "127.0.0.1",
    port: Number(process.env.AOS_DB_PORT ?? 5432),
    database: process.env.AOS_DB_NAME ?? "aos",
    user: process.env.AOS_DB_USER ?? "postgres",
    password: process.env.AOS_DB_PASSWORD ?? "",
  };
}

function checksum(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

async function migrationFiles() {
  const entries = await readdir(MIGRATIONS_DIR);
  // Filenames are zero-padded (`0001_`…`0030_`), so lexical order is
  // migration order. The README is explicit that the order is load-bearing:
  // `app_user` cannot exist before `person`.
  return entries.filter((name) => name.endsWith(".sql")).sort();
}

/**
 * The ledger lives in `public` rather than `app` because `app` is created by
 * `0001` — the runner must be able to record its own progress before the
 * first migration has run.
 */
async function ensureLedger(client) {
  await client.query(`
    create table if not exists public.schema_migrations (
      filename    text        primary key,
      checksum    text        not null,
      applied_at  timestamptz not null default now()
    )
  `);
}

async function appliedMigrations(client) {
  const { rows } = await client.query(
    "select filename, checksum from public.schema_migrations",
  );
  return new Map(rows.map((row) => [row.filename, row.checksum]));
}

async function status(client) {
  await ensureLedger(client);
  const applied = await appliedMigrations(client);
  const files = await migrationFiles();

  for (const filename of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, filename), "utf8");
    const recorded = applied.get(filename);
    if (recorded === undefined) {
      console.log(`  pending  ${filename}`);
    } else if (recorded !== checksum(sql)) {
      console.log(`  CHANGED  ${filename}  (applied, but the file has been edited since)`);
    } else {
      console.log(`  applied  ${filename}`);
    }
  }
}

async function apply(client) {
  await ensureLedger(client);
  const applied = await appliedMigrations(client);
  const files = await migrationFiles();
  let count = 0;

  for (const filename of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, filename), "utf8");
    const digest = checksum(sql);
    const recorded = applied.get(filename);

    if (recorded !== undefined) {
      if (recorded !== digest) {
        throw new Error(
          `${filename} has already been applied but its contents have changed since. ` +
            `Editing an applied migration makes two databases disagree about their own ` +
            `schema. Write a new migration instead, or drop and rebuild this database.`,
        );
      }
      continue;
    }

    // Each migration is its own transaction: a failure half-way through
    // leaves the database on the last good migration rather than in a state
    // no migration describes.
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query(
        "insert into public.schema_migrations (filename, checksum) values ($1, $2)",
        [filename, digest],
      );
      await client.query("commit");
      console.log(`  applied  ${filename}`);
      count += 1;
    } catch (error) {
      await client.query("rollback");
      throw new Error(`${filename} failed to apply: ${error.message}`);
    }
  }

  console.log(
    count === 0 ? "\nAlready up to date." : `\n${count} migration(s) applied.`,
  );
}

async function main() {
  const config = connectionConfig();
  const client = new pg.Client(config);

  try {
    await client.connect();
  } catch (error) {
    // The password is deliberately not echoed back, here or anywhere else.
    console.error(
      `Could not connect to Postgres at ${config.host}:${config.port} as ` +
        `"${config.user}" (database "${config.database}").\n${error.message}`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    if (process.argv.includes("--status")) {
      await status(client);
    } else {
      await apply(client);
    }
  } catch (error) {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

await main();
