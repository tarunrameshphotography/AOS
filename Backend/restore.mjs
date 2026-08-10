#!/usr/bin/env node
/**
 * Restore a backup produced by `Backend/backup.mjs`.
 *
 * DELIBERATELY AWKWARD, same reasoning as `bootstrap-production.ts`: a
 * restore overwrites a database and a document tree, so a mistyped command
 * must not be able to land on the office's real ones by accident.
 *
 *   - The target database and target storage root are always explicit
 *     arguments. There is no default that points at "aos" or
 *     AOS_STORAGE_ROOT.
 *   - If the target database name is "aos" (or matches AOS_DB_NAME), it also
 *     requires AOS_RESTORE_CONFIRM to equal that name.
 *   - The target database must not already exist unless --drop-existing is
 *     given, so a restore can never silently merge into or replace a live
 *     database by mistake.
 *
 * Usage — a restore drill, into an isolated database and folder:
 *   node Backend/restore.mjs --backup C:\AOS\Backups\<run> --db aos_restore_drill --storage-root C:\AOS\RestoreDrill --create-db
 *
 * Usage — disaster recovery onto the real office database (after it has
 * been dropped or is otherwise empty; never run against a live one):
 *   $env:AOS_RESTORE_CONFIRM="aos"
 *   node Backend/restore.mjs --backup <run> --db aos --storage-root C:\AOS\Data --create-db
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadDotEnv } from "./env.mjs";
import { connectionConfig } from "./migrate.mjs";

loadDotEnv();

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function resolvePgBinDir() {
  if (process.env.AOS_PG_BIN_DIR?.trim()) return process.env.AOS_PG_BIN_DIR.trim();
  const candidate = "C:\\Program Files\\PostgreSQL\\17\\bin";
  if (existsSync(path.join(candidate, "pg_dump.exe"))) return candidate;
  return null;
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const backupDir = args.backup;
  const targetDb = args.db;
  const targetStorageRoot = args["storage-root"];
  const createDb = Boolean(args["create-db"]);
  const dropExisting = Boolean(args["drop-existing"]);

  if (!backupDir) fail("Missing --backup <folder>.");
  if (!targetDb) fail("Missing --db <target database name>.");
  if (!targetStorageRoot) fail("Missing --storage-root <target folder for document bytes>.");
  if (!existsSync(path.join(backupDir, "aos.dump"))) {
    fail(`No aos.dump found under "${backupDir}" — is this a backup.mjs output folder?`);
  }

  const config = connectionConfig();
  const office = process.env.AOS_DB_NAME ?? "aos";
  if (targetDb === office && process.env.AOS_RESTORE_CONFIRM !== targetDb) {
    fail(
      `--db "${targetDb}" matches the office database name.\n` +
        `  Re-run with AOS_RESTORE_CONFIRM=${targetDb} if you intend to restore onto it.`,
    );
  }

  const binDir = resolvePgBinDir();
  if (!binDir) fail("Could not find pg_restore. Set AOS_PG_BIN_DIR to the PostgreSQL 'bin' folder.");
  const psql = path.join(binDir, "psql.exe");
  const pgRestore = path.join(binDir, "pg_restore.exe");
  const pgEnv = { ...process.env, PGPASSWORD: config.password };

  console.log(`AOS restore — from ${backupDir}\n  into database "${targetDb}" on ${config.host}:${config.port}\n`);

  const manifest = JSON.parse(await readFile(path.join(backupDir, "manifest.json"), "utf8"));
  console.log(`  Backup taken ${manifest.takenAt} of "${manifest.database}"\n`);

  console.log(`  [1/3] Preparing database "${targetDb}"`);
  if (dropExisting) {
    await run(psql, ["-h", config.host, "-p", String(config.port), "-U", config.user, "-d", "postgres", "-c", `drop database if exists "${targetDb}"`], pgEnv);
  }
  if (createDb) {
    await run(psql, ["-h", config.host, "-p", String(config.port), "-U", config.user, "-d", "postgres", "-c", `create database "${targetDb}"`], pgEnv);
  }

  console.log(`  [2/3] Restoring aos.dump -> "${targetDb}"`);
  await run(
    pgRestore,
    ["-h", config.host, "-p", String(config.port), "-U", config.user, "-d", targetDb, "--no-owner", "--role", config.user, path.join(backupDir, "aos.dump")],
    pgEnv,
  );

  const sourceDocuments = path.join(backupDir, "Data", "Documents");
  const targetDocuments = path.join(targetStorageRoot, "Documents");
  console.log(`  [3/3] Restoring document bytes -> "${targetDocuments}"`);
  await mkdir(targetStorageRoot, { recursive: true });
  if (existsSync(sourceDocuments)) {
    await cp(sourceDocuments, targetDocuments, { recursive: true });
    const count = (await readdir(sourceDocuments, { recursive: true })).length;
    console.log(`        copied ${count} entries`);
  } else {
    console.log("        (backup had no documents on disk — nothing to copy)");
  }

  console.log(`\nDone. "${targetDb}" and "${targetStorageRoot}" now hold the ${manifest.takenAt} backup.\n`);
}

await main();
