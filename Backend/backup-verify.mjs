/**
 * Prove a backup is restorable — or say precisely why it is not.
 *
 * WHY THIS EXISTS: `backup.mjs` used to finish by printing the dump's size in
 * kilobytes. A size is not evidence. A truncated dump, a dump written while
 * the disk filled up, and a document tree that lost half its files during the
 * copy all produce a plausible-looking folder with a plausible-looking size,
 * and the failure is discovered on the one day it matters. The Stage 4 audit
 * recorded this as the reason the existing backup could not be called proven.
 *
 * WHAT "VERIFIED" MEANS HERE, exactly — three independent checks:
 *
 *   1. The database dump is READABLE BY POSTGRES. `pg_restore --list` parses
 *      the custom-format archive and prints its table of contents. It is the
 *      cheapest honest test available: it exercises the real reader, not a
 *      guess about the file format, and it fails on a truncated or corrupted
 *      archive. A dump whose table of contents is empty is also a failure —
 *      that is what a dump of the wrong (or an empty) database looks like.
 *   2. The dump's SHA-256 matches what was recorded when it was written, so
 *      bit rot or a partial copy to a network drive is caught.
 *   3. Every document file listed in the manifest is present, the right size,
 *      and hashes to the recorded SHA-256. Document bytes are the half of AOS
 *      that Postgres cannot vouch for (`document.file_path` is a pointer, not
 *      the bytes), so they get the same treatment as the dump.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: restore into a scratch database on its
 * own. That is a heavier operation with its own failure modes and its own
 * command (`Backend/restore.mjs`, and `Backend/restore-drill.mjs` for the
 * rehearsal). Verification has to be cheap enough to run after EVERY backup,
 * unattended, or it will not be run at all.
 *
 * Usage:
 *   node Backend/backup-verify.mjs                     verify the newest backup
 *   node Backend/backup-verify.mjs --backup <folder>   verify one specific run
 *   node Backend/backup-verify.mjs --all               verify every retained run
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadDotEnv } from "./env.mjs";
import { requirePgBinDir, runCapturing } from "./pg-tools.mjs";

loadDotEnv();

/** The manifest shape this module writes and reads. Bumped when the contents
 * change, so a verifier meeting an older backup says so rather than failing
 * on a missing field. */
export const MANIFEST_FORMAT_VERSION = 2;

// ---------------------------------------------------------------------------
// Hashing and indexing
// ---------------------------------------------------------------------------

/** SHA-256 of a file, streamed. Document scans run over the whole store, and
 * reading a 25 MB PDF into memory to hash it is a waste on a machine that is
 * also serving the office. */
export function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Every file under `root`, relative-path form, forward slashes — the same
 * spelling `storage-server.mjs` uses for an object path, so a manifest entry
 * is directly comparable to a `document.file_path` value. */
async function walkFiles(root, prefix = "") {
  let entries;
  try {
    entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, relative)));
    } else {
      files.push(relative);
    }
  }
  return files.sort();
}

/**
 * Index a document tree: relative path, size and SHA-256 for every file.
 *
 * The `.meta.json` sidecars are indexed alongside the documents themselves.
 * They carry the content type, and a restored PDF that has lost its sidecar
 * is served back to an employee as `application/octet-stream` — a download
 * that no longer opens. They are part of the store, so they are part of the
 * evidence.
 */
export async function indexDocuments(documentsRoot) {
  if (!existsSync(documentsRoot)) return { fileCount: 0, totalBytes: 0, files: [] };

  const relativePaths = await walkFiles(documentsRoot);
  const files = [];
  let totalBytes = 0;
  for (const relative of relativePaths) {
    const full = path.join(documentsRoot, ...relative.split("/"));
    const info = await stat(full);
    totalBytes += info.size;
    files.push({ path: relative, sizeBytes: info.size, sha256: await hashFile(full) });
  }
  return { fileCount: files.length, totalBytes, files };
}

// ---------------------------------------------------------------------------
// Verifying
// ---------------------------------------------------------------------------

/**
 * Check one backup folder. Returns a report rather than throwing, so a caller
 * verifying several can present all of them and a caller verifying one can
 * decide what a failure means (backup.mjs treats it as fatal; the operator CLI
 * prints it and moves to the next run).
 */
export async function verifyBackup(runDir, options = {}) {
  const problems = [];
  const checks = [];

  const manifestPath = path.join(runDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return { runDir, ok: false, checks, problems: ["No manifest.json — this is not a backup folder."] };
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    return { runDir, ok: false, checks, problems: [`manifest.json is unreadable: ${error.message}`] };
  }

  // A pre-Stage-4 backup has no checksums to compare against. Say so plainly
  // and verify what can still be verified, rather than reporting a pass that
  // rests on evidence the file does not contain.
  const legacy = (manifest.formatVersion ?? 1) < MANIFEST_FORMAT_VERSION;
  if (legacy) {
    problems.push(
      `Written by an older backup (manifest formatVersion ${manifest.formatVersion ?? 1}). ` +
        `It carries no checksums, so only the archive-readable check below applies. ` +
        `Take a fresh backup to get full verification.`,
    );
  }

  // ── 1. The dump is readable by Postgres, and describes something ─────────
  const dumpPath = path.join(runDir, "aos.dump");
  if (!existsSync(dumpPath)) {
    problems.push("aos.dump is missing.");
  } else {
    const pgRestore = path.join(options.pgBinDir ?? requirePgBinDir("pg_restore"), "pg_restore.exe");
    try {
      const toc = await runCapturing(pgRestore, ["--list", dumpPath], process.env);
      // `--list` on a valid archive prints a header of comment lines and then
      // one line per object. A file that parses but describes nothing is a
      // dump of the wrong database, which is a failure worth naming.
      const objectLines = toc
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0 && !line.startsWith(";"));
      if (objectLines.length === 0) {
        problems.push("aos.dump is a valid archive but contains no objects — it backed up nothing.");
      } else {
        checks.push(`archive readable — ${objectLines.length} objects in the table of contents`);
      }
    } catch (error) {
      problems.push(`aos.dump could not be read by pg_restore: ${error.message}`);
    }

    // ── 2. The dump still hashes to what was written ───────────────────────
    if (!legacy) {
      const recorded = manifest.databaseDump ?? {};
      const info = await stat(dumpPath);
      if (recorded.sizeBytes !== undefined && info.size !== recorded.sizeBytes) {
        problems.push(
          `aos.dump is ${info.size} bytes but the manifest recorded ${recorded.sizeBytes}.`,
        );
      } else if (recorded.sha256) {
        const actual = await hashFile(dumpPath);
        if (actual !== recorded.sha256) {
          problems.push("aos.dump's SHA-256 does not match the manifest — the file has changed since it was written.");
        } else {
          checks.push(`dump checksum matches (${(info.size / 1024 / 1024).toFixed(1)} MB)`);
        }
      }
    }
  }

  // ── 3. Every document file is present, right-sized and unchanged ─────────
  if (!legacy) {
    const documentsRoot = path.join(runDir, "Data", "Documents");
    const expected = manifest.documents ?? { fileCount: 0, files: [] };
    let missing = 0;
    let mismatched = 0;

    for (const entry of expected.files ?? []) {
      const full = path.join(documentsRoot, ...entry.path.split("/"));
      if (!existsSync(full)) {
        missing += 1;
        if (missing <= 5) problems.push(`Document missing from the backup: ${entry.path}`);
        continue;
      }
      const info = await stat(full);
      if (info.size !== entry.sizeBytes || (await hashFile(full)) !== entry.sha256) {
        mismatched += 1;
        if (mismatched <= 5) problems.push(`Document does not match its checksum: ${entry.path}`);
      }
    }
    if (missing > 5) problems.push(`…and ${missing - 5} more missing document(s).`);
    if (mismatched > 5) problems.push(`…and ${mismatched - 5} more corrupted document(s).`);

    if ((expected.files ?? []).length === 0) {
      checks.push("no documents in this backup (the store was empty when it was taken)");
    } else if (missing === 0 && mismatched === 0) {
      checks.push(
        `all ${expected.fileCount} document file(s) present and unchanged ` +
          `(${(expected.totalBytes / 1024 / 1024).toFixed(1)} MB)`,
      );
    }
  }

  return { runDir, ok: problems.length === 0, checks, problems, manifest };
}

/** Backup run folders under `backupRoot`, oldest first. Named by timestamp, so
 * lexical order is chronological — the same assumption `backup.mjs`'s
 * retention already makes. */
export async function listBackupRuns(backupRoot) {
  if (!existsSync(backupRoot)) return [];
  const entries = await readdir(backupRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => path.join(backupRoot, name));
}

export function printReport(report) {
  console.log(`\n  ${report.ok ? "OK  " : "FAIL"}  ${report.runDir}`);
  for (const check of report.checks) console.log(`          ${check}`);
  for (const problem of report.problems) console.log(`          ! ${problem}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const backupRoot = process.env.AOS_BACKUP_ROOT?.trim() || "C:\\AOS\\Backups";

  const explicitIndex = argv.indexOf("--backup");
  const explicit = explicitIndex >= 0 ? argv[explicitIndex + 1] : null;
  const all = argv.includes("--all");

  let runs;
  if (explicit) {
    runs = [explicit];
  } else {
    const available = await listBackupRuns(backupRoot);
    if (available.length === 0) {
      console.error(
        `\n  No backups found under "${backupRoot}".\n` +
          `  Run \`npm run backup\` first, or pass --backup <folder>.\n`,
      );
      process.exit(1);
    }
    runs = all ? available : [available[available.length - 1]];
  }

  console.log(`\nAOS backup verification — ${runs.length} run(s)`);
  const pgBinDir = requirePgBinDir("pg_restore");

  let failures = 0;
  for (const runDir of runs) {
    const report = await verifyBackup(runDir, { pgBinDir });
    printReport(report);
    if (!report.ok) failures += 1;
  }

  console.log(
    failures === 0
      ? `\nAll ${runs.length} backup(s) verified.\n`
      : `\n${failures} of ${runs.length} backup(s) FAILED verification.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

// Only when run directly — `backup.mjs` and `restore.mjs` import the functions
// and must not trigger the CLI. Compared as file URLs rather than as paths:
// on Windows `process.argv[1]` is `E:\...` and `import.meta.url` is
// `file:///E:/...`, and every string comparison between those two spellings is
// wrong in a way that only shows up on this platform.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
