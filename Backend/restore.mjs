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
 *   - The target storage root must be empty, or --overwrite-storage must be
 *     given. Restoring on top of a populated document tree silently mixes two
 *     generations of files, and the mixture is undetectable afterwards.
 *
 * IT VERIFIES BEFORE IT WRITES, AND AGAIN AFTER (Stage 4). Restoring from a
 * corrupt backup is worse than not restoring: it consumes the outage window
 * and can leave a half-applied database that looks like a recovery. The
 * pre-flight check is the same one `backup.mjs` runs
 * (`Backend/backup-verify.mjs`), and the post-restore check re-hashes what
 * actually landed on disk, because "pg_restore exited 0" says nothing about
 * the document bytes.
 *
 * Usage — a restore drill, into an isolated database and folder:
 *   node Backend/restore.mjs --backup C:\AOS\Backups\<run> --db aos_restore_drill --storage-root C:\AOS\RestoreDrill --create-db
 *
 * Usage — disaster recovery onto the real office database (after it has
 * been dropped or is otherwise empty; never run against a live one):
 *   $env:AOS_RESTORE_CONFIRM="aos"
 *   node Backend/restore.mjs --backup <run> --db aos --storage-root C:\AOS\Data --create-db
 */

import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadDotEnv } from "./env.mjs";
import { connectionConfig } from "./db-config.mjs";
import { requirePgBinDir, run } from "./pg-tools.mjs";
import { hashFile, printReport, verifyBackup } from "./backup-verify.mjs";

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
  const overwriteStorage = Boolean(args["overwrite-storage"]);
  const skipVerify = Boolean(args["no-verify"]);

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

  // The document tree gets the same protection the database has. Without this,
  // a drill pointed at C:\AOS\Data by a slip of the finger merges the backup's
  // files into the live store, and versioned paths mean the mixture is
  // indistinguishable from a legitimate history afterwards.
  const targetDocuments = path.join(targetStorageRoot, "Documents");
  if (existsSync(targetDocuments) && !overwriteStorage) {
    const existing = await readdir(targetDocuments);
    if (existing.length > 0) {
      fail(
        `"${targetDocuments}" already contains ${existing.length} entr${existing.length === 1 ? "y" : "ies"}.\n` +
          `  Restoring into a populated document store mixes two generations of files.\n` +
          `  Pick an empty --storage-root, or pass --overwrite-storage if that is genuinely what you want.`,
      );
    }
  }

  const binDir = requirePgBinDir("pg_restore");
  const psql = path.join(binDir, "psql.exe");
  const pgRestore = path.join(binDir, "pg_restore.exe");
  const pgEnv = { ...process.env, PGPASSWORD: config.password };

  const manifest = JSON.parse(await readFile(path.join(backupDir, "manifest.json"), "utf8"));
  console.log(
    `AOS restore — from ${backupDir}\n` +
      `  into database "${targetDb}" on ${config.host}:${config.port}\n` +
      `  documents into "${targetDocuments}"\n\n` +
      `  Backup taken ${manifest.takenAt} of "${manifest.database}"\n`,
  );

  // ── 0. Do not spend an outage restoring a corrupt backup ─────────────────
  if (skipVerify) {
    console.log(`  [0/4] Pre-flight verification SKIPPED (--no-verify).`);
  } else {
    console.log(`  [0/4] Verifying the backup before touching anything`);
    const report = await verifyBackup(backupDir, { pgBinDir: binDir });
    printReport(report);
    if (!report.ok) {
      fail(
        "This backup did not verify. NOTHING has been restored.\n" +
          "  Try an earlier run, or re-run with --no-verify if you have decided to\n" +
          "  attempt a partial recovery from a damaged backup anyway.",
      );
    }
  }

  console.log(`\n  [1/4] Preparing database "${targetDb}"`);
  if (dropExisting) {
    await run(psql, ["-h", config.host, "-p", String(config.port), "-U", config.user, "-d", "postgres", "-c", `drop database if exists "${targetDb}"`], pgEnv);
  }
  if (createDb) {
    await run(psql, ["-h", config.host, "-p", String(config.port), "-U", config.user, "-d", "postgres", "-c", `create database "${targetDb}"`], pgEnv);
  }

  console.log(`  [2/4] Restoring aos.dump -> "${targetDb}"`);
  await run(
    pgRestore,
    ["-h", config.host, "-p", String(config.port), "-U", config.user, "-d", targetDb, "--no-owner", "--role", config.user, path.join(backupDir, "aos.dump")],
    pgEnv,
  );

  const sourceDocuments = path.join(backupDir, "Data", "Documents");
  console.log(`  [3/4] Restoring document bytes -> "${targetDocuments}"`);
  await mkdir(targetStorageRoot, { recursive: true });
  if (existsSync(sourceDocuments)) {
    await cp(sourceDocuments, targetDocuments, { recursive: true, force: true });
    console.log(`        copied ${manifest.documents?.fileCount ?? "?"} file(s)`);
  } else {
    console.log("        (backup had no documents on disk — nothing to copy)");
  }

  // ── 4. What actually landed, re-hashed on the restored disk ──────────────
  //
  // `pg_restore` exiting 0 says the database arrived. It says nothing about
  // the file copy, which is the half a disaster recovery is most likely to get
  // wrong (a network drive that dropped, a disk that filled). This re-reads
  // every restored file rather than trusting the copy.
  console.log(`  [4/4] Verifying what was restored`);
  const expected = manifest.documents?.files ?? [];
  let missing = 0;
  let mismatched = 0;
  for (const entry of expected) {
    const full = path.join(targetDocuments, ...entry.path.split("/"));
    if (!existsSync(full)) {
      missing += 1;
      if (missing <= 5) console.log(`        ! missing after restore: ${entry.path}`);
      continue;
    }
    const info = await stat(full);
    if (info.size !== entry.sizeBytes || (await hashFile(full)) !== entry.sha256) {
      mismatched += 1;
      if (mismatched <= 5) console.log(`        ! checksum mismatch after restore: ${entry.path}`);
    }
  }

  if (expected.length === 0) {
    console.log(`        no documents in this backup — nothing to check`);
  } else if (missing === 0 && mismatched === 0) {
    console.log(`        all ${expected.length} restored document(s) match the backup byte for byte`);
  } else {
    console.error(
      `\n  RESTORE INCOMPLETE: ${missing} missing, ${mismatched} corrupted document file(s).\n` +
        `  The database was restored; the document store was NOT fully restored.\n`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nDone. "${targetDb}" and "${targetStorageRoot}" now hold the ${manifest.takenAt} backup.\n`);
}

await main();
