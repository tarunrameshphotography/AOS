/**
 * Stage 4 Item 3 — the three production paths the review pass flagged as
 * unexercised under `aos_app`: document upload/download, bank submission,
 * and mail.
 *
 * `security.test.ts` proves the role attributes, the RLS policies, and that
 * the authentication lifecycle survives a non-superuser connection. It does
 * not touch documents, submissions or mail, because none of those existed in
 * its fixtures. This file starts a SEPARATE, out-of-process API server
 * connected as `aos_app` — mirroring `security.test.ts`'s
 * `startAppRoleServer` exactly — and drives it against a real (throwaway)
 * storage-server and a real (capture-mode) mail-server, so every grant
 * `0033_application_role.sql` makes for these three tables (`document`,
 * `submission`, `submission_package`, `submission_package_recipient`,
 * `submission_package_email`, `submission_package_document`) is exercised by
 * the actual code path, not inferred from reading the migration.
 *
 * Nothing here reaches Gmail: `AOS_MAIL_PROVIDER=capture` writes the message
 * to a throwaway directory and reports success, exactly as
 * `submissions.test.ts` already does. Nothing here reaches the office disk:
 * the storage root is a throwaway temp directory, matching `documents.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import pg from "pg";

import { hashPassword } from "@domain/auth/password.js";
import type { Role } from "@domain/permissions/index.js";

import { adminPool, closeAdminPool, pool, withActor } from "./db.js";

const PASSWORD = "integration-test-password";
const FIXTURE = readFileSync(path.join(process.cwd(), "tests", "fixtures", "pan-card.pdf"));
const FIXTURE_HASH = createHash("sha256").update(FIXTURE).digest("hex");

/** Thrown away with the process — see security.test.ts's identical rationale. */
const APP_ROLE_PASSWORD = randomBytes(18).toString("base64url");

let storageServer: ChildProcess;
let storageRoot: string;
let mailServer: ChildProcess;
let mailCaptureDir: string;
let appRoleServer: ChildProcess;
let appRoleBaseUrl: string;

/** A direct connection as aos_app, for the database-level assertions
 * (event append-only) that HTTP cannot exercise on its own. */
let appRole: pg.Client;

/** Whatever aos_app's password was before this file touched it — see
 * security.test.ts's identical variable for why this must be restored
 * rather than unconditionally nulled. */
let previousAppRolePassword: string | null = null;

async function waitHealthy(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${url} did not become healthy in time.`);
}

async function startStorageServer(): Promise<void> {
  storageRoot = mkdtempSync(path.join(tmpdir(), "aos-secwf-storage-"));
  storageServer = spawn(process.execPath, [path.join(process.cwd(), "Backend", "storage-server.mjs")], {
    env: { ...process.env, AOS_STORAGE_PORT: "4332", AOS_STORAGE_ROOT: storageRoot },
    stdio: "pipe",
  });
  await waitHealthy("http://127.0.0.1:4332/health");
}

async function startMailServer(): Promise<void> {
  mailCaptureDir = mkdtempSync(path.join(tmpdir(), "aos-secwf-mail-"));
  mailServer = spawn(process.execPath, [path.join(process.cwd(), "Backend", "mail-server.mjs")], {
    env: {
      ...process.env,
      AOS_MAIL_PORT: "4333",
      AOS_MAIL_PROVIDER: "capture",
      AOS_MAIL_CAPTURE_DIR: mailCaptureDir,
    },
    stdio: "pipe",
  });
  await waitHealthy("http://127.0.0.1:4333/health");
}

/**
 * The API, out of process and connected as `aos_app`, pointed at the
 * throwaway storage and mail servers above — never the office backends on
 * 4319/4320. Mirrors `security.test.ts`'s `startAppRoleServer`.
 */
async function startAppRoleServer(): Promise<void> {
  const port = 4334;
  const output: string[] = [];
  appRoleServer = spawn(
    process.execPath,
    [
      path.join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs"),
      "--config",
      "vite.server.config.ts",
      path.join(process.cwd(), "Backend", "api-server.ts"),
    ],
    {
      env: {
        ...process.env,
        AOS_DB_NAME: "aos_test",
        AOS_REQUIRE_DB_NAME: "aos_test",
        AOS_DB_USER: "aos_app",
        AOS_DB_PASSWORD: APP_ROLE_PASSWORD,
        AOS_API_PORT: String(port),
        AOS_API_NO_LISTEN: "0",
        AOS_STORAGE_SERVER_URL: "http://127.0.0.1:4332",
        AOS_MAIL_SERVER_URL: "http://127.0.0.1:4333",
      },
      stdio: "pipe",
    },
  );
  appRoleServer.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  appRoleServer.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));

  appRoleBaseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${appRoleBaseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`API server as aos_app did not start:\n${output.join("")}`);
}

interface Session {
  readonly token: string;
  readonly userId: string;
}

async function createEmployee(role: Role): Promise<{ username: string; authIdentityId: string }> {
  const username = `secwf.${role}.${randomUUID().slice(0, 8)}`;
  const passwordHash = await hashPassword(PASSWORD);
  const authIdentityId = randomUUID();

  await withActor(null, async (client) => {
    const person = await client.query<{ id: string }>(
      `insert into person (full_name) values ($1) returning id`,
      [`Workflow ${role}`],
    );
    const user = await client.query<{ id: string }>(
      `insert into app_user (person_id, auth_identity_id, username, password_hash, is_active)
       values ($1, $2, $3, $4, true) returning id`,
      [person.rows[0]!.id, authIdentityId, username, passwordHash],
    );
    await client.query(`insert into user_role (user_id, role, granted_by) values ($1, $2, $1)`, [
      user.rows[0]!.id,
      role,
    ]);
  });

  return { username, authIdentityId };
}

async function api(
  path_: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    rawBody?: Buffer;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${appRoleBaseUrl}${path_}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.rawBody
      ? { body: new Uint8Array(options.rawBody) }
      : options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : Buffer.from(await response.arrayBuffer());
  return { status: response.status, body };
}

async function signIn(username: string): Promise<Session> {
  const { status, body } = await api("/api/auth/login", {
    method: "POST",
    body: { username, password: PASSWORD },
  });
  expect(status, `login failed for ${username}: ${JSON.stringify(body)}`).toBe(200);
  return { token: body.token, userId: body.user.id };
}

async function anyLoanProductId(): Promise<string> {
  const { rows } = await pool.query(`select id from loan_product limit 1`);
  return rows[0]!.id;
}

beforeAll(async () => {
  await startStorageServer();
  await startMailServer();

  const { rows } = await adminPool().query<{ rolpassword: string | null }>(
    `select rolpassword from pg_authid where rolname = 'aos_app'`,
  );
  previousAppRolePassword = rows[0]?.rolpassword ?? null;
  await adminPool().query(`alter role aos_app password '${APP_ROLE_PASSWORD}'`);
  await startAppRoleServer();

  appRole = new pg.Client({
    host: process.env.AOS_DB_HOST ?? "127.0.0.1",
    port: Number(process.env.AOS_DB_PORT ?? 5432),
    database: "aos_test",
    user: "aos_app",
    password: APP_ROLE_PASSWORD,
  });
  await appRole.connect();
}, 90_000);

afterAll(async () => {
  appRoleServer?.kill();
  await appRole?.end();
  storageServer?.kill();
  mailServer?.kill();
  rmSync(storageRoot, { recursive: true, force: true });
  rmSync(mailCaptureDir, { recursive: true, force: true });
  if (previousAppRolePassword === null) {
    await adminPool().query(`alter role aos_app password null`);
  } else {
    await adminPool().query(`alter role aos_app password '${previousAppRolePassword}'`);
  }
  await closeAdminPool();
  if (!pool.ended) await pool.end();
}, 30_000);

describe("document upload/download, submission and mail, served by an API running as aos_app", () => {
  it("carries a case from creation through a sent bank submission, entirely as aos_app", async () => {
    const owner = await createEmployee("telecaller");
    const verifier = await createEmployee("login_executive");

    const ownerSession = await signIn(owner.username);
    const verifierSession = await signIn(verifier.username);

    // 1. Synthetic customer and case.
    const customer = await api("/api/customers", {
      method: "POST",
      token: ownerSession.token,
      body: { fullName: `Workflow Applicant ${randomUUID().slice(0, 8)}`, phone: "9843012345", city: "Coimbatore" },
    });
    expect(customer.status, JSON.stringify(customer.body)).toBe(200);

    const loanProductId = await anyLoanProductId();
    const created = await api("/api/cases", {
      method: "POST",
      token: ownerSession.token,
      body: { applicantId: customer.body.id, loanProductId },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const caseId = created.body.id;

    await api(`/api/cases/${caseId}/stage`, { method: "PUT", token: ownerSession.token, body: { stage: "contacted" } });
    const toDocsPending = await api(`/api/cases/${caseId}/stage`, {
      method: "PUT",
      token: ownerSession.token,
      body: { stage: "documents_pending" },
    });
    expect(toDocsPending.status, JSON.stringify(toDocsPending.body)).toBe(200);

    // 2. Requirements, real rule-generated ones, read as aos_app.
    const listing = await api(`/api/cases/${caseId}/requirements`, { token: ownerSession.token });
    expect(listing.status, JSON.stringify(listing.body)).toBe(200);
    const requirements: any[] = listing.body.requirements;
    expect(requirements.length).toBeGreaterThan(0);

    // 3. Upload a synthetic document through the real API/storage path, for
    //    every generated requirement — same shape documents.test.ts uses.
    let firstDocumentId: string | null = null;
    for (const requirement of requirements) {
      const uploaded = await fetch(
        `${appRoleBaseUrl}/api/cases/${caseId}/requirements/${requirement.id}/documents`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ownerSession.token}`,
            "Content-Type": "application/pdf",
            "X-File-Name": "pan-card.pdf",
          },
          body: new Uint8Array(FIXTURE),
        },
      );
      const uploadedBody = (await uploaded.json()) as { document: { id: string } };
      expect(uploaded.status, JSON.stringify(uploadedBody)).toBe(200);
      if (!firstDocumentId) firstDocumentId = uploadedBody.document.id;
    }
    expect(firstDocumentId, "no document id came back from an upload").toBeTruthy();

    // 4. Verify each uploaded document (document.verify, as the Login
    //    Executive — Docs/Permission Matrix.md).
    for (const requirement of requirements) {
      const decided = await api(`/api/cases/${caseId}/requirements/${requirement.id}/decision`, {
        method: "PUT",
        token: verifierSession.token,
        body: { decision: "verified" },
      });
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    }

    const ready = await api(`/api/cases/${caseId}`, { token: ownerSession.token });
    expect(ready.body.stage, "case did not advance to ready_for_submission").toBe("ready_for_submission");

    // 5. Download the first document back and verify the bytes/hash — the
    //    round trip through the real storage backend, as aos_app end to end.
    const downloaded = await api(`/api/documents/${firstDocumentId}/download`, { token: ownerSession.token });
    expect(downloaded.status).toBe(200);
    const downloadedHash = createHash("sha256").update(downloaded.body as Buffer).digest("hex");
    expect(downloadedHash).toBe(FIXTURE_HASH);
    expect((downloaded.body as Buffer).byteLength).toBe(FIXTURE.byteLength);

    // 6. The real bank submission path, far enough to prove every database
    //    operation submission needs works as aos_app: branch lookup,
    //    submission + recipient inserts, sendable-documents read, prepare
    //    (pure), send (package/email/document inserts, one UPDATE per email,
    //    then the submission and case UPDATEs).
    const lenders = await api("/api/lenders", { token: verifierSession.token });
    expect(lenders.status, JSON.stringify(lenders.body)).toBe(200);
    const branches = lenders.body.flatMap((lender: any) => lender.branches);
    expect(branches.length).toBeGreaterThan(0);
    const branchId = branches[0].id;

    const submission = await api(`/api/cases/${caseId}/submissions`, {
      method: "POST",
      token: verifierSession.token,
      body: {
        branchOrganisationId: branchId,
        recipients: [{ email: "banker@example.test", name: "Test Banker", kind: "to", isPrimary: true }],
      },
    });
    expect(submission.status, JSON.stringify(submission.body)).toBe(200);
    const submissionId = submission.body.id;

    const sendable = await api(`/api/cases/${caseId}/submissions/${submissionId}/sendable-documents`, {
      token: verifierSession.token,
    });
    expect(sendable.status, JSON.stringify(sendable.body)).toBe(200);
    const documentIds = sendable.body.filter((d: any) => !d.blockedBecause).map((d: any) => d.documentId);
    expect(documentIds.length).toBeGreaterThan(0);

    const prepared = await api(`/api/cases/${caseId}/submissions/${submissionId}/package/prepare`, {
      method: "POST",
      token: verifierSession.token,
      body: { documentIds },
    });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);

    // 7. Send — exercises the mail path (capture provider: never reaches
    //    Gmail, never needs real lender emails) without faking the database
    //    interactions it depends on.
    const sent = await api(`/api/cases/${caseId}/submissions/${submissionId}/package/send`, {
      method: "POST",
      token: verifierSession.token,
      body: { documentIds, fingerprint: prepared.body.fingerprint },
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.failedCount, JSON.stringify(sent.body)).toBe(0);
    expect(sent.body.sentCount).toBeGreaterThan(0);

    const finalCase = await api(`/api/cases/${caseId}`, { token: verifierSession.token });
    expect(finalCase.body.stage, "case did not advance to submitted").toBe("submitted");

    const finalSubmission = await api(`/api/cases/${caseId}/submissions`, { token: verifierSession.token });
    const matching = finalSubmission.body.find((s: any) => s.id === submissionId);
    expect(matching.status).toBe("submitted");

    // 8. Requirements, document metadata and submissions remain readable
    //    exactly as the application expects, after the whole flow.
    const finalRequirements = await api(`/api/cases/${caseId}/requirements`, { token: ownerSession.token });
    expect(finalRequirements.status).toBe(200);
    expect(finalRequirements.body.progress.outstandingCount ?? 0).toBe(0);

    // 9. Audit events from this workflow: insertable by aos_app (they exist,
    //    because the flow above completed only by writing them), but not
    //    rewritable or erasable — checked against the SPECIFIC rows this
    //    workflow produced, not a generic probe row.
    const events = await pool.query<{ id: string; event_type: string }>(
      `select id, event_type from event where case_id = $1 order by occurred_at`,
      [caseId],
    );
    const eventTypes = events.rows.map((r) => r.event_type);
    expect(eventTypes).toContain("document.uploaded");
    expect(eventTypes).toContain("document.verified");
    expect(eventTypes).toContain("submission.created");
    expect(eventTypes).toContain("submission.documents_sent");
    expect(eventTypes).toContain("case.stage_changed");
    expect(events.rows.length).toBeGreaterThan(0);

    await appRole.query(`select set_config('app.auth_identity_id', $1, false)`, [owner.authIdentityId]);
    const probeEventId = events.rows[0]!.id;
    await expect(
      appRole.query(`update event set event_type = 'tampered' where id = $1`, [probeEventId]),
    ).rejects.toThrow(/permission denied/i);
    await expect(appRole.query(`delete from event where id = $1`, [probeEventId])).rejects.toThrow(
      /permission denied/i,
    );
    await appRole.query(`select set_config('app.auth_identity_id', '', false)`);
  }, 60_000);
});
