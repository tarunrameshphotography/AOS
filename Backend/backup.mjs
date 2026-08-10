#!/usr/bin/env node
/**
 * Back up the operational database and the document store together.
 *
 * WHY THEY MOVE TOGETHER: `document.file_path` in Postgres is a pointer, not
 * the bytes (see AOS_STORAGE_ROOT's comment in `.env.example`). A database
 * backup restored without the matching document tree is a system that
 * believes in files it cannot open; a document tree restored without the
 * matching database is bytes nobody can find. One backup run produces one
 * timestamped folder holding both, so a restore is always restoring a single
 * consistent moment.
 *
 * WHAT IT USES: `pg_dump -Fc` (Postgres's own custom format — compressed,
 * and the only format `pg_restore` can apply selectively). It is not on
 * PATH by default on a Windows install; `resolvePgBinDir()` finds it next to
 * the running server the same way `Backend/storage-server.mjs` finds its
 * data root — an env var first, then the obvious default location.
 *
 * Usage:
 *   node Backend/backup.mjs
 *
 * Destination: AOS_BACKUP_ROOT (default C:\AOS\Backups), one subfolder per
 * run named by timestamp. Retention: AOS_BACKUP_RETENTION runs are kept
 * (default 14); older ones are deleted after a new backup succeeds, never
 * before — a failed backup must not cost you the last good one.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadDotEnv } from "./env.mjs";
import { connectionConfig } from "./migrate.mjs";

loadDotEnv();

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

/** Same search order `storage-server.mjs` uses for its own root: an explicit
 * env var wins, then the one place the PostgreSQL 17 Windows installer puts
 * its client tools. Neither is guessed silently past that — an unresolved
 * binary is a loud failure, not a wrong one. */
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

async function main() {
  const config = connectionConfig();
  const binDir = resolvePgBinDir();
  if (!binDir) {
    console.error(
      "\n  Could not find pg_dump. Set AOS_PG_BIN_DIR to the PostgreSQL 'bin' folder\n" +
        "  (e.g. C:\\Program Files\\PostgreSQL\\17\\bin) and try again.\n",
    );
    process.exit(1);
  }
  const pgDump = path.join(binDir, "pg_dump.exe");

  const storageRoot = process.env.AOS_STORAGE_ROOT?.trim() || "C:\\AOS\\Data";
  const backupRoot = process.env.AOS_BACKUP_ROOT?.trim() || "C:\\AOS\\Backups";
  const retention = Number(process.env.AOS_BACKUP_RETENTION ?? 14);

  const runDir = path.join(backupRoot, timestamp());
  await mkdir(runDir, { recursive: true });

  console.log(`AOS backup — ${runDir}\n`);

  console.log(`  [1/3] Database "${config.database}" -> aos.dump`);
  await run(
    pgDump,
    ["-Fc", "-h", config.host, "-p", String(config.port), "-U", config.user, "-d", config.database, "-f", path.join(runDir, "aos.dump")],
    { ...process.env, PGPASSWORD: config.password },
  );

  const documentsRoot = path.join(storageRoot, "Documents");
  console.log(`  [2/3] Document store "${documentsRoot}" -> Data\\Documents`);
  if (existsSync(documentsRoot)) {
    await cp(documentsRoot, path.join(runDir, "Data", "Documents"), { recursive: true });
  } else {
    console.log("        (no documents on disk yet — nothing to copy)");
  }

  await writeFile(
    path.join(runDir, "manifest.json"),
    JSON.stringify(
      {
        takenAt: new Date().toISOString(),
        database: config.database,
        host: config.host,
        storageRoot,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log(`  [3/3] Retention — keeping the newest ${retention} run(s)`);
  const entries = (await readdir(backupRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const stale = entries.slice(0, Math.max(0, entries.length - retention));
  for (const name of stale) {
    await rm(path.join(backupRoot, name), { recursive: true, force: true });
    console.log(`        removed old backup ${name}`);
  }

  const { size } = await stat(path.join(runDir, "aos.dump"));
  console.log(`\nDone. Database dump: ${(size / 1024).toFixed(0)} KB. Backup at:\n  ${runDir}\n`);
}

await main();
