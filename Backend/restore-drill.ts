#!/usr/bin/env node
/**
 * The restore drill: prove that a backup can actually be restored.
 *
 * WHY THIS IS A SCRIPT AND NOT A PARAGRAPH IN A RUNBOOK: a backup that has
 * never been restored is not a backup, it is a folder. Stage 4's audit found
 * `backup.mjs` and `restore.mjs` written, reviewed, and never once executed —
 * `C:\AOS\Backups` did not exist. A procedure nobody has run is a hypothesis.
 *
 * WHAT IT PROVES, end to end, against real PostgreSQL and the real storage
 * backend — never against a mock, and never against office data:
 *
 *   1. A case, a customer, a requirement and an uploaded document can be
 *      created through the ORDINARY code paths (`Backend/cases.ts`,
 *      `Backend/documents.ts`) — not by inserting rows, which would prove
 *      nothing about the shape real data has.
 *   2. `backup.mjs` captures both halves and verifies them.
 *   3. Verification actually DETECTS damage — the drill deliberately corrupts
 *      a copy of the backup and requires the verifier to fail it. A checker
 *      that has never returned false is not known to check anything.
 *   4. `restore.mjs` reconstructs a separate database and a separate document
 *      tree from that backup.
 *   5. The restored case exists, the restored document METADATA exists, the
 *      case-to-document relationship survives, and the restored bytes hash
 *      identically to what was uploaded.
 *   6. The restore is REPEATABLE — run twice, same result.
 *
 * SAFETY. Everything this script touches is named for the drill and created
 * by the drill:
 *
 *   database  aos_drill_source     the synthetic source
 *   database  aos_restore_drill    the restore target
 *   folder    C:\AOS\DrillData     synthetic document bytes
 *   folder    C:\AOS\DrillBackups  the drill's backups
 *   folder    C:\AOS\RestoreDrill  restored document bytes
 *
 * It refuses to start if any of those names collides with the configured
 * office database, and its cleanup drops databases ONLY by exact match
 * against that list. `AOS_STORAGE_ROOT` and `AOS_BACKUP_ROOT` from `.env` are
 * never read; the office `aos` database is never connected to.
 *
 * The synthetic customer is obviously synthetic ("Drill Testcase") and carries
 * no real personal data. The document is `tests/fixtures/pan-card.pdf`, a
 * generated fixture already in the repository.
 *
 * Usage:
 *   npm run restore-drill              run it, then clean up the drill targets
 *   npm run restore-drill -- --keep    leave the drill databases/folders behind
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// The drill's own environment, set BEFORE anything imports db.ts
//
// `Backend/db.ts` reads AOS_DB_NAME and `Backend/storage-client.ts` reads
// AOS_STORAGE_SERVER_URL at module load, and `loadDotEnv` never overwrites a
// variable that is already set. Assigning them here and importing those
// modules dynamically below is what keeps the drill off the office database
// without the caller having to remember an env prefix.
// ---------------------------------------------------------------------------

const SOURCE_DB = "aos_drill_source";
const RESTORE_DB = "aos_restore_drill";
const DRILL_STORAGE = "C:\\AOS\\DrillData";
const DRILL_BACKUPS = "C:\\AOS\\DrillBackups";
const RESTORE_STORAGE = "C:\\AOS\\RestoreDrill";
const STORAGE_PORT = "4339";

const DRILL_DATABASES = [SOURCE_DB, RESTORE_DB];
const DRILL_FOLDERS = [DRILL_STORAGE, DRILL_BACKUPS, RESTORE_STORAGE];

const { loadDotEnv } = await import("./env.mjs");
loadDotEnv();

const officeDatabase = process.env.AOS_DB_NAME ?? "aos";
if (DRILL_DATABASES.includes(officeDatabase)) {
  console.error(
    `\n  Refusing to run: the configured database "${officeDatabase}" is one of the\n` +
      `  drill's own disposable names. The drill would destroy it.\n`,
  );
  process.exit(1);
}
const officeStorage = (process.env.AOS_STORAGE_ROOT ?? "C:\\AOS\\Data").replace(/\\+$/, "");
if (DRILL_FOLDERS.some((folder) => folder.toLowerCase() === officeStorage.toLowerCase())) {
  console.error(
    `\n  Refusing to run: AOS_STORAGE_ROOT ("${officeStorage}") is one of the drill's\n` +
      `  own disposable folders. The drill would destroy it.\n`,
  );
  process.exit(1);
}

// Now safe to point everything at the drill's targets.
process.env.AOS_DB_NAME = SOURCE_DB;
process.env.AOS_STORAGE_ROOT = DRILL_STORAGE;
process.env.AOS_STORAGE_SERVER_URL = `http://127.0.0.1:${STORAGE_PORT}`;
process.env.AOS_BACKUP_ROOT = DRILL_BACKUPS;
process.env.AOS_BACKUP_RETENTION = "5";
// The drill is not a test suite pointing at a test database; it IS the
// database it names. Clearing this stops a stray value in the environment
// from tripping db.ts's guard against a name it was never meant to police.
delete process.env.AOS_REQUIRE_DB_NAME;

const { hashPassword } = await import("@domain/auth/password.js");
const { pool, withActor } = await import("./db.js");
const { createCustomer } = await import("./customers.js");
const { createCase } = await import("./cases.js");
const { listCaseRequirements, uploadDocument, decideDocument } = await import("./documents.js");
const { verifyBackup } = await import("./backup-verify.mjs");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const KEEP = process.argv.includes("--keep");
const results: { step: string; ok: boolean; detail: string }[] = [];

function record(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${step}\n        ${detail}`);
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

function sha256(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A `pg.Client` against an arbitrary database on the configured server —
 * for creating and dropping the drill's databases, and for reading the
 * RESTORED one, which is not the database the pool is connected to. */
async function connectTo(database: string) {
  const pg = (await import("pg")).default;
  const client = new pg.Client({
    host: process.env.AOS_DB_HOST ?? "127.0.0.1",
    port: Number(process.env.AOS_DB_PORT ?? 5432),
    database,
    user: process.env.AOS_DB_USER ?? "postgres",
    password: process.env.AOS_DB_PASSWORD ?? "",
  });
  await client.connect();
  return client;
}

async function dropAndCreate(database: string): Promise<void> {
  const admin = await connectTo("postgres");
  try {
    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
      [database],
    );
    await admin.query(`drop database if exists "${database}"`);
    await admin.query(`create database "${database}"`);
  } finally {
    await admin.end();
  }
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [path.join(process.cwd(), "Backend", script), ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

async function startStorageServer(root: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [path.join(process.cwd(), "Backend", "storage-server.mjs")], {
    env: { ...process.env, AOS_STORAGE_PORT: STORAGE_PORT, AOS_STORAGE_ROOT: root },
    stdio: "pipe",
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${STORAGE_PORT}/health`);
      if (response.ok) return child;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error("The drill's storage-server did not become healthy in time.");
}

// ---------------------------------------------------------------------------
// The drill
// ---------------------------------------------------------------------------

interface Seeded {
  caseId: string;
  caseNumber: string;
  documentId: string;
  filePath: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  customerName: string;
}

/**
 * Build a case with a verified document on it, through the same functions the
 * API server calls. Nothing here inserts a `loan_case` or a `document` row
 * directly: the point is to back up data with the shape real data has,
 * including the storage path `buildStoragePath` computes and the requirement
 * linkage `regenerateRequirements` establishes.
 */
async function seedSyntheticCase(): Promise<Seeded> {
  const fixture = readFileSync(path.join(process.cwd(), "tests", "fixtures", "pan-card.pdf"));
  const customerName = "Drill Testcase";

  return await withActor(null, async (client) => {
    // An employee holding both roles — one creates and uploads, the same one
    // verifies. Two accounts would prove nothing extra about a backup.
    const person = await client.query<{ id: string }>(
      `insert into person (full_name) values ($1) returning id`,
      ["Drill Operator"],
    );
    const user = await client.query<{ id: string }>(
      `insert into app_user (person_id, auth_identity_id, username, password_hash, is_active)
       values ($1, $2, $3, $4, true) returning id`,
      [person.rows[0]!.id, randomUUID(), `drill.${randomUUID().slice(0, 8)}`, await hashPassword(randomUUID())],
    );
    const userId = user.rows[0]!.id;
    for (const role of ["telecaller", "login_executive"]) {
      await client.query(`insert into user_role (user_id, role, granted_by) values ($1, $2, $1)`, [
        userId,
        role,
      ]);
    }

    const { rows: authRows } = await client.query<{ auth_identity_id: string }>(
      `select auth_identity_id from app_user where id = $1`,
      [userId],
    );
    const actor = {
      userId,
      authIdentityId: authRows[0]!.auth_identity_id,
      roles: ["telecaller", "login_executive"] as never,
      overrides: [],
    };

    const customer: any = await createCustomer(client, actor, {
      fullName: customerName,
      mobile: "9000000000",
      locality: "Drill Nagar",
    });

    // Any seeded product will do; the first by display order is the one the
    // office's own New Case screen offers first.
    const { rows: productRows } = await client.query<{ id: string }>(
      `select id from loan_product where is_active order by display_order, code limit 1`,
    );
    if (!productRows[0]) throw new Error("No loan products are seeded — migrations did not run.");

    const created: any = await createCase(client, actor, {
      applicantId: customer.id,
      loanProductId: productRows[0].id,
      requestedAmount: 1_000_000,
    });

    // Requirements are generated by the real engine from the real rules.
    const listed = await listCaseRequirements(client, actor, created.id);
    const target = listed.requirements.find((requirement) => requirement.document === null);
    if (!target) throw new Error("The generated checklist had no open requirement to upload against.");

    const uploaded = await uploadDocument(client, actor, created.id, target.id, {
      bytes: fixture,
      fileName: "drill-pan-card.pdf",
      contentType: "application/pdf",
    });
    await decideDocument(client, actor, created.id, target.id, { decision: "verified" });

    const { rows: documentRows } = await client.query<{
      id: string;
      file_path: string;
      file_name: string;
      file_size_bytes: string;
    }>(`select id, file_path, file_name, file_size_bytes from document where id = $1`, [
      uploaded.document!.id,
    ]);
    const document = documentRows[0]!;

    return {
      caseId: created.id,
      caseNumber: created.caseNumber,
      documentId: document.id,
      filePath: document.file_path,
      fileName: document.file_name,
      sha256: sha256(fixture),
      sizeBytes: Number(document.file_size_bytes),
      customerName,
    };
  });
}

/** Damage a COPY of the backup and require the verifier to notice. Two
 * separate injuries, because they exercise different checks: a truncated dump
 * must fail the archive-readable test, and a flipped document byte must fail
 * the checksum test. */
async function proveVerificationDetectsDamage(goodRun: string): Promise<void> {
  const damaged = `${goodRun}-DAMAGED`;
  await rm(damaged, { recursive: true, force: true });
  await cp(goodRun, damaged, { recursive: true });

  // Injury 1 — a dump cut off half way, the classic "the disk filled up".
  const dumpPath = path.join(damaged, "aos.dump");
  const { size } = await stat(dumpPath);
  await truncate(dumpPath, Math.floor(size / 2));

  const truncatedReport = await verifyBackup(damaged);
  record(
    "verification detects a truncated database dump",
    !truncatedReport.ok,
    truncatedReport.ok
      ? "THE VERIFIER PASSED A HALF-WRITTEN DUMP — verification is not trustworthy."
      : `refused it: ${truncatedReport.problems[0]}`,
  );

  // Injury 2 — a good dump, but a document that rotted on disk.
  await rm(damaged, { recursive: true, force: true });
  await cp(goodRun, damaged, { recursive: true });

  const manifest = JSON.parse(await readFile(path.join(damaged, "manifest.json"), "utf8"));
  const victim = (manifest.documents?.files ?? []).find((file: { path: string }) =>
    file.path.endsWith(".pdf"),
  );
  if (!victim) {
    record("verification detects a corrupted document", false, "No document in the backup to corrupt.");
  } else {
    const victimPath = path.join(damaged, "Data", "Documents", ...victim.path.split("/"));
    const bytes = await readFile(victimPath);
    // One flipped byte, same length — the injury a checksum catches and a
    // size comparison does not.
    const offset = Math.floor(bytes.length / 2);
    bytes[offset] = (bytes[offset] ?? 0) ^ 0xff;
    await writeFile(victimPath, bytes);

    const corruptedReport = await verifyBackup(damaged);
    record(
      "verification detects a corrupted document (one flipped byte, same size)",
      !corruptedReport.ok,
      corruptedReport.ok
        ? "THE VERIFIER PASSED A CORRUPTED DOCUMENT — checksums are not being compared."
        : `refused it: ${corruptedReport.problems[0]}`,
    );
  }

  await rm(damaged, { recursive: true, force: true });
}

/** Read the RESTORED database and the RESTORED disk, and check that what came
 * back is what went in. */
async function verifyRestoredContents(seeded: Seeded): Promise<void> {
  const restored = await connectTo(RESTORE_DB);
  try {
    const { rows: caseRows } = await restored.query(
      `select id, case_number, stage from loan_case where id = $1`,
      [seeded.caseId],
    );
    record(
      "the case exists after restore",
      caseRows.length === 1 && caseRows[0].case_number === seeded.caseNumber,
      caseRows.length === 1
        ? `${caseRows[0].case_number} at stage "${caseRows[0].stage}"`
        : "the case was not found in the restored database",
    );

    const { rows: documentRows } = await restored.query(
      `select id, file_path, file_name, file_size_bytes from document where id = $1`,
      [seeded.documentId],
    );
    record(
      "the document metadata exists after restore",
      documentRows.length === 1 && documentRows[0].file_path === seeded.filePath,
      documentRows.length === 1
        ? `${documentRows[0].file_name} at ${documentRows[0].file_path}`
        : "the document row was not found in the restored database",
    );

    // The link the whole split-storage design depends on: requirement ->
    // satisfying document -> case. If this survives but the bytes do not, the
    // system believes in a file it cannot open, which is the failure mode
    // backing them up together exists to prevent.
    const { rows: linkRows } = await restored.query(
      `select r.id, r.status, d.id as document_id
         from document_requirement r
         join document d on d.id = r.satisfied_by_document_id
        where r.case_id = $1 and d.id = $2`,
      [seeded.caseId, seeded.documentId],
    );
    record(
      "the case-to-document relationship is intact after restore",
      linkRows.length === 1 && linkRows[0].status === "verified",
      linkRows.length === 1
        ? `requirement ${linkRows[0].id} is "${linkRows[0].status}", satisfied by the restored document`
        : "no requirement in the restored database points at the restored document",
    );

    const { rows: eventRows } = await restored.query(
      `select event_type from event where case_id = $1 order by occurred_at`,
      [seeded.caseId],
    );
    record(
      "the audit trail survived the restore",
      eventRows.length >= 3,
      `${eventRows.length} event(s): ${eventRows.map((row: { event_type: string }) => row.event_type).join(", ")}`,
    );
  } finally {
    await restored.end();
  }

  // The bytes themselves, off the restored disk, hashed.
  const restoredFile = path.join(RESTORE_STORAGE, "Documents", ...seeded.filePath.split("/"));
  if (!existsSync(restoredFile)) {
    record("the restored document bytes match the original", false, `not on disk: ${restoredFile}`);
    return;
  }
  const restoredBytes = await readFile(restoredFile);
  const actual = sha256(restoredBytes);
  record(
    "the restored document bytes match the original byte for byte",
    actual === seeded.sha256 && restoredBytes.length === seeded.sizeBytes,
    actual === seeded.sha256
      ? `sha256 ${actual.slice(0, 16)}… over ${restoredBytes.length} bytes`
      : `sha256 differs — expected ${seeded.sha256.slice(0, 16)}…, got ${actual.slice(0, 16)}…`,
  );
}

async function cleanUp(): Promise<void> {
  const admin = await connectTo("postgres");
  try {
    for (const database of DRILL_DATABASES) {
      // Exact-match only. There is no pattern here and there must never be
      // one: a `like 'aos%'` would match the office database.
      await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [database],
      );
      await admin.query(`drop database if exists "${database}"`);
      console.log(`  removed database ${database}`);
    }
  } finally {
    await admin.end();
  }

  // The backups folder is deliberately NOT removed: it is the artefact that
  // proves the drill ran, and it holds nothing but synthetic data.
  for (const folder of [DRILL_STORAGE, RESTORE_STORAGE]) {
    await rm(folder, { recursive: true, force: true });
    console.log(`  removed folder ${folder}`);
  }
}

async function main(): Promise<void> {
  console.log(
    `\nAOS RESTORE DRILL\n` +
      `  source database   ${SOURCE_DB}\n` +
      `  restore target    ${RESTORE_DB}\n` +
      `  source documents  ${DRILL_STORAGE}\n` +
      `  backups           ${DRILL_BACKUPS}\n` +
      `  restored docs     ${RESTORE_STORAGE}\n` +
      `  office database   ${officeDatabase} (never connected to)\n`,
  );

  let storageServer: ChildProcess | null = null;

  try {
    // ── 1. A disposable source, migrated by the real runner ───────────────
    console.log("\n[1/6] Building the synthetic source");
    await dropAndCreate(SOURCE_DB);
    const migrated = runScript("migrate.mjs", [], { AOS_DB_NAME: SOURCE_DB });
    if (migrated.status !== 0) fail(`Migrations failed against ${SOURCE_DB}:\n${migrated.stdout}${migrated.stderr}`);
    console.log(`  migrated ${SOURCE_DB}`);

    await rm(DRILL_STORAGE, { recursive: true, force: true });
    await rm(RESTORE_STORAGE, { recursive: true, force: true });
    await mkdir(DRILL_STORAGE, { recursive: true });
    storageServer = await startStorageServer(DRILL_STORAGE);
    console.log(`  storage-server up on ${STORAGE_PORT}, rooted at ${DRILL_STORAGE}`);

    const seeded = await seedSyntheticCase();
    record(
      "a synthetic case with a verified document was created through the real code paths",
      true,
      `case ${seeded.caseNumber}, document ${seeded.fileName} (${seeded.sizeBytes} bytes) at ${seeded.filePath}`,
    );

    // Released before the backup so nothing holds the tree open mid-copy.
    await pool.end();
    storageServer.kill();
    storageServer = null;

    // ── 2. Back it up ─────────────────────────────────────────────────────
    console.log("\n[2/6] Backing up");
    const backup = runScript("backup.mjs", [], {
      AOS_DB_NAME: SOURCE_DB,
      AOS_STORAGE_ROOT: DRILL_STORAGE,
      AOS_BACKUP_ROOT: DRILL_BACKUPS,
    });
    process.stdout.write(backup.stdout ?? "");
    record(
      "backup.mjs completed and self-verified",
      backup.status === 0,
      backup.status === 0 ? "exit 0, verification passed" : `exit ${backup.status}: ${backup.stderr}`,
    );
    if (backup.status !== 0) fail("The backup failed; there is nothing to restore.");

    const runs = (await readdir(DRILL_BACKUPS, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.endsWith("-DAMAGED"))
      .map((entry) => entry.name)
      .sort();
    const goodRun = path.join(DRILL_BACKUPS, runs[runs.length - 1]!);

    // ── 3. Prove the verifier can say no ──────────────────────────────────
    console.log("\n[3/6] Proving verification detects damage");
    await proveVerificationDetectsDamage(goodRun);

    // ── 4. Restore ────────────────────────────────────────────────────────
    console.log("\n[4/6] Restoring into disposable targets");
    const restore = runScript("restore.mjs", [
      "--backup", goodRun,
      "--db", RESTORE_DB,
      "--storage-root", RESTORE_STORAGE,
      "--create-db",
      "--drop-existing",
    ], { AOS_DB_NAME: SOURCE_DB });
    process.stdout.write(restore.stdout ?? "");
    record(
      "restore.mjs completed and verified what it wrote",
      restore.status === 0,
      restore.status === 0 ? "exit 0" : `exit ${restore.status}: ${restore.stderr}`,
    );

    // ── 5. Check what came back ───────────────────────────────────────────
    console.log("\n[5/6] Checking the restored data");
    await verifyRestoredContents(seeded);

    // ── 6. Do it again ────────────────────────────────────────────────────
    console.log("\n[6/6] Repeating the restore");
    const second = runScript("restore.mjs", [
      "--backup", goodRun,
      "--db", RESTORE_DB,
      "--storage-root", RESTORE_STORAGE,
      "--create-db",
      "--drop-existing",
      "--overwrite-storage",
    ], { AOS_DB_NAME: SOURCE_DB });
    record(
      "the restore procedure is repeatable",
      second.status === 0,
      second.status === 0 ? "a second identical restore also succeeded" : `exit ${second.status}: ${second.stderr}`,
    );
    if (second.status === 0) await verifyRestoredContents(seeded);

    // ── Report ────────────────────────────────────────────────────────────
    const failed = results.filter((result) => !result.ok);
    const report =
      `# Restore drill — ${new Date().toISOString()}\n\n` +
      `Source database: ${SOURCE_DB}\nRestore target: ${RESTORE_DB}\n` +
      `Backup: ${goodRun}\n\n` +
      results.map((result) => `- ${result.ok ? "PASS" : "FAIL"} — ${result.step}\n  ${result.detail}`).join("\n") +
      `\n\n${failed.length === 0 ? "ALL CHECKS PASSED." : `${failed.length} CHECK(S) FAILED.`}\n`;
    await writeFile(path.join(DRILL_BACKUPS, "last-drill-report.md"), report, "utf8");

    console.log(
      `\n${"=".repeat(70)}\n` +
        `  ${results.length - failed.length}/${results.length} checks passed.\n` +
        `  Report written to ${path.join(DRILL_BACKUPS, "last-drill-report.md")}\n` +
        `${"=".repeat(70)}\n`,
    );
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    if (storageServer) storageServer.kill();
    if (!pool.ended) await pool.end().catch(() => {});
    if (KEEP) {
      console.log(`\n  --keep given; the drill databases and folders were left in place.\n`);
    } else {
      console.log("\nCleaning up the drill's disposable targets");
      await cleanUp();
      console.log(`  kept ${DRILL_BACKUPS} as the artefact proving the drill ran\n`);
    }
  }
}

await main();
