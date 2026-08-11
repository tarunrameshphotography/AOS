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
 * PATH by default on a Windows install; `Backend/pg-tools.mjs` finds it next
 * to the running server the same way `Backend/storage-server.mjs` finds its
 * data root — an env var first, then the obvious default location.
 *
 * EVERY RUN IS VERIFIED BEFORE IT IS TRUSTED (Stage 4). This script used to
 * finish by printing the dump's size, which is not evidence: a truncated dump
 * and a good one both have a size. It now records a SHA-256 for the dump and
 * for every document file, then re-reads all of it through
 * `Backend/backup-verify.mjs` before the run is declared successful.
 *
 * RETENTION ONLY PRUNES AFTER VERIFICATION PASSES. The old ordering deleted
 * the oldest run as soon as a new folder existed. A backup that turned out to
 * be unreadable would therefore have cost you a good one — the exact opposite
 * of what retention is for.
 *
 * Usage:
 *   node Backend/backup.mjs               back up, verify, then prune
 *   node Backend/backup.mjs --no-verify   skip verification (not recommended)
 *
 * Destination: AOS_BACKUP_ROOT (default C:\AOS\Backups), one subfolder per
 * run named by timestamp. Retention: AOS_BACKUP_RETENTION runs are kept
 * (default 14); older ones are deleted after a new backup succeeds AND
 * verifies, never before.
 */

import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadDotEnv } from "./env.mjs";
import { connectionConfig } from "./db-config.mjs";
import { requirePgBinDir, run } from "./pg-tools.mjs";
import {
  MANIFEST_FORMAT_VERSION,
  hashFile,
  indexDocuments,
  printReport,
  verifyBackup,
} from "./backup-verify.mjs";

loadDotEnv();

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

async function main() {
  const skipVerify = process.argv.includes("--no-verify");
  const config = connectionConfig();
  const binDir = requirePgBinDir("pg_dump");
  const pgDump = path.join(binDir, "pg_dump.exe");

  const storageRoot = process.env.AOS_STORAGE_ROOT?.trim() || "C:\\AOS\\Data";
  const backupRoot = process.env.AOS_BACKUP_ROOT?.trim() || "C:\\AOS\\Backups";
  const retention = Number(process.env.AOS_BACKUP_RETENTION ?? 14);

  const runDir = path.join(backupRoot, timestamp());
  await mkdir(runDir, { recursive: true });

  console.log(`AOS backup — ${runDir}\n`);

  // ── 1. The database ──────────────────────────────────────────────────────
  const dumpPath = path.join(runDir, "aos.dump");
  console.log(`  [1/4] Database "${config.database}" -> aos.dump`);
  await run(
    pgDump,
    ["-Fc", "-h", config.host, "-p", String(config.port), "-U", config.user, "-d", config.database, "-f", dumpPath],
    { ...process.env, PGPASSWORD: config.password },
  );

  // ── 2. The document bytes ────────────────────────────────────────────────
  const documentsRoot = path.join(storageRoot, "Documents");
  const backedUpDocuments = path.join(runDir, "Data", "Documents");
  console.log(`  [2/4] Document store "${documentsRoot}" -> Data\\Documents`);
  if (existsSync(documentsRoot)) {
    await cp(documentsRoot, backedUpDocuments, { recursive: true });
  } else {
    console.log("        (no documents on disk yet — nothing to copy)");
  }

  // ── 3. The manifest, with the evidence verification will check against ───
  //
  // Hashes are computed from the COPY, not from the source. The question a
  // restore needs answered is "is what is in this folder intact", and hashing
  // the original would answer a different one — it would happily record a
  // correct checksum for a file that failed to copy.
  console.log(`  [3/4] Indexing and checksumming`);
  const dumpStat = await stat(dumpPath);
  const documents = await indexDocuments(backedUpDocuments);
  const manifest = {
    formatVersion: MANIFEST_FORMAT_VERSION,
    takenAt: new Date().toISOString(),
    database: config.database,
    host: config.host,
    storageRoot,
    databaseDump: {
      file: "aos.dump",
      sizeBytes: dumpStat.size,
      sha256: await hashFile(dumpPath),
    },
    documents,
  };
  await writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(
    `        ${documents.fileCount} document file(s), ${(documents.totalBytes / 1024 / 1024).toFixed(1)} MB; ` +
      `dump ${(dumpStat.size / 1024 / 1024).toFixed(1)} MB`,
  );

  // ── 4. Verify, and only then prune ───────────────────────────────────────
  if (skipVerify) {
    console.log(`  [4/4] Verification SKIPPED (--no-verify). Retention not applied.`);
    console.log(`\nDone, unverified. Backup at:\n  ${runDir}\n`);
    return;
  }

  console.log(`  [4/4] Verifying`);
  const report = await verifyBackup(runDir, { pgBinDir: binDir });
  printReport(report);

  if (!report.ok) {
    console.error(
      `\n  THIS BACKUP DID NOT VERIFY. It has been left in place for inspection and\n` +
        `  NOTHING has been deleted — your previous backups are untouched.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const entries = (await readdir(backupRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const stale = entries.slice(0, Math.max(0, entries.length - retention));
  for (const name of stale) {
    await rm(path.join(backupRoot, name), { recursive: true, force: true });
    console.log(`\n        retention — removed old backup ${name}`);
  }

  console.log(`\nDone. Verified backup at:\n  ${runDir}\n`);
}

await main();
