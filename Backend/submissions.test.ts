/**
 * Stage 3D acceptance tests — bank submissions and sending their documents
 * through the real mail backend.
 *
 * Two layers, for the reason documented in `Backend/submissions.ts`'s own
 * header: most of this can and should run over real HTTP against a real
 * (capture-mode) `mail-server.mjs`, exactly as `documents.test.ts` runs
 * against a real `storage-server.mjs`. Provider-failure and retry semantics
 * need deterministic control over what the provider returns, which a real
 * process cannot give test-by-test without restarting it — so those few
 * cases call `Backend/submissions.ts`'s functions directly with an in-memory
 * fake `EmailProvider`, the same injection point `sendPackage`/`retryPackage`
 * already expose for exactly this reason.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { hashPassword } from "@domain/auth/password.js";
import type { Role } from "@domain/permissions/index.js";
import type { EmailProvider, EmailSendResult, OutgoingEmail } from "@domain/communications/index.js";

import { createApiServer } from "./api-server.js";
import { pool, withActor } from "./db.js";
import type { Actor } from "./authorize.js";
import { createSubmission, preparePackage, retryPackage, sendableDocuments, sendPackage } from "./submissions.js";

let baseUrl: string;
let server: ReturnType<typeof createApiServer>;
let storageServer: ChildProcess;
let storageRoot: string;
let mailServer: ChildProcess;
let mailCaptureDir: string;

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

/** Mirrors `documents.test.ts`'s `startStorageServer` — a throwaway instance
 * on the port `vitest.integration.config.ts` points the client at, never the
 * office backend. */
async function startStorageServer(): Promise<void> {
  storageRoot = mkdtempSync(path.join(tmpdir(), "aos-test-storage-"));
  storageServer = spawn(process.execPath, [path.join(process.cwd(), "Backend", "storage-server.mjs")], {
    env: { ...process.env, AOS_STORAGE_PORT: "4329", AOS_STORAGE_ROOT: storageRoot },
    stdio: "pipe",
  });
  await waitHealthy("http://127.0.0.1:4329/health");
}

/** A throwaway `mail-server.mjs` in `capture` mode — writes messages to disk
 * and reports success, never reaching Gmail. On the port
 * `vitest.integration.config.ts`'s `AOS_MAIL_SERVER_URL` points
 * `Backend/mail-client.ts` at. */
async function startMailServer(): Promise<void> {
  mailCaptureDir = mkdtempSync(path.join(tmpdir(), "aos-test-mail-"));
  mailServer = spawn(process.execPath, [path.join(process.cwd(), "Backend", "mail-server.mjs")], {
    env: {
      ...process.env,
      AOS_MAIL_PORT: "4330",
      AOS_MAIL_PROVIDER: "capture",
      AOS_MAIL_CAPTURE_DIR: mailCaptureDir,
    },
    stdio: "pipe",
  });
  await waitHealthy("http://127.0.0.1:4330/health");
}

const PASSWORD = "integration-test-password";
const FIXTURE = readFileSync(path.join(process.cwd(), "tests", "fixtures", "pan-card.pdf"));

interface Session {
  readonly token: string;
  readonly userId: string;
}

async function createEmployee(role: Role): Promise<string> {
  const username = `${role}.${randomUUID().slice(0, 8)}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withActor(null, async (client) => {
    const person = await client.query<{ id: string }>(
      `insert into person (full_name) values ($1) returning id`,
      [`Test ${role}`],
    );
    const user = await client.query<{ id: string }>(
      `insert into app_user (person_id, auth_identity_id, username, password_hash, is_active)
       values ($1, $2, $3, $4, true) returning id`,
      [person.rows[0]!.id, randomUUID(), username, passwordHash],
    );
    await client.query(`insert into user_role (user_id, role, granted_by) values ($1, $2, $1)`, [
      user.rows[0]!.id,
      role,
    ]);
  });

  return username;
}

async function api(
  path_: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${baseUrl}${path_}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function signInAs(role: Role): Promise<Session> {
  const username = await createEmployee(role);
  const { status, body } = await api("/api/auth/login", {
    method: "POST",
    body: { username, password: PASSWORD },
  });
  expect(status, JSON.stringify(body)).toBe(200);
  return { token: body.token, userId: body.user.id };
}

function actorFor(session: Session, roles: readonly Role[]): Actor {
  return { userId: session.userId, authIdentityId: randomUUID(), roles, overrides: [] };
}

async function anyLoanProductId(): Promise<string> {
  const { rows } = await pool.query(`select id from loan_product limit 1`);
  return rows[0]!.id;
}

async function aCase(session: Session): Promise<{ id: string; stage: string }> {
  const customer = await api("/api/customers", {
    method: "POST",
    token: session.token,
    body: { fullName: `Applicant ${randomUUID().slice(0, 8)}`, phone: "9843012345", city: "Coimbatore" },
  });
  const created = await api("/api/cases", {
    method: "POST",
    token: session.token,
    body: { applicantId: customer.body.id, loanProductId: await anyLoanProductId() },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body;
}

async function move(session: Session, caseId: string, stage: string): Promise<{ status: number; body: any }> {
  return await api(`/api/cases/${caseId}/stage`, { method: "PUT", token: session.token, body: { stage } });
}

/** Takes a fresh case all the way to `ready_for_submission`: opens it,
 * uploads and verifies every generated requirement, exactly the path
 * `documents.test.ts` already proves — this file starts where that one
 * ends. */
async function aReadyCase(owner: Session, verifier: Session): Promise<{ id: string }> {
  const loanCase = await aCase(owner);
  await move(owner, loanCase.id, "contacted");
  const advanced = await move(owner, loanCase.id, "documents_pending");
  expect(advanced.status, JSON.stringify(advanced.body)).toBe(200);

  const listing = await api(`/api/cases/${loanCase.id}/requirements`, { token: owner.token });
  const requirements: any[] = listing.body.requirements;
  expect(requirements.length).toBeGreaterThan(0);

  for (const requirement of requirements) {
    const uploaded = await fetch(`${baseUrl}/api/cases/${loanCase.id}/requirements/${requirement.id}/documents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/pdf",
        "X-File-Name": "pan-card.pdf",
      },
      body: new Uint8Array(FIXTURE),
    });
    expect(uploaded.status).toBe(200);
  }
  for (const requirement of requirements) {
    const decided = await api(`/api/cases/${loanCase.id}/requirements/${requirement.id}/decision`, {
      method: "PUT",
      token: verifier.token,
      body: { decision: "verified" },
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  }

  const ready = await api(`/api/cases/${loanCase.id}`, { token: owner.token });
  expect(ready.body.stage).toBe("ready_for_submission");
  return { id: loanCase.id };
}

async function twoBranchIds(token: string): Promise<[string, string]> {
  const lenders = await api("/api/lenders", { token });
  expect(lenders.status, JSON.stringify(lenders.body)).toBe(200);
  const branches = lenders.body.flatMap((lender: any) => lender.branches);
  expect(branches.length).toBeGreaterThanOrEqual(2);
  return [branches[0].id, branches[1].id];
}

async function eventsFor(caseId: string): Promise<{ event_type: string; entity_type: string }[]> {
  const { rows } = await pool.query(
    `select event_type, entity_type from event where case_id = $1 order by occurred_at`,
    [caseId],
  );
  return rows;
}

beforeAll(async () => {
  await startStorageServer();
  await startMailServer();
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  storageServer.kill();
  mailServer.kill();
  rmSync(storageRoot, { recursive: true, force: true });
  rmSync(mailCaptureDir, { recursive: true, force: true });
  await pool.end();
});

// ---------------------------------------------------------------------------
// HTTP-level — the full path through the real (capture) mail backend
// ---------------------------------------------------------------------------

describe("bank submission and email dispatch, over real HTTP and a real mail backend", () => {
  it("creates a submission, sends only verified documents, and advances the case to Submitted", async () => {
    const owner = await signInAs("telecaller");
    const verifier = await signInAs("login_executive");
    const loanCase = await aReadyCase(owner, verifier);
    const [branchId] = await twoBranchIds(owner.token);

    // `submission.create` is a login-desk permission, not a telecaller one
    // (Docs/Permission Matrix.md) — the telecaller who owns the case collects
    // documents; the login executive lodges the file. Every submission call
    // below uses `verifier`'s token for that reason.
    const created = await api(`/api/cases/${loanCase.id}/submissions`, {
      method: "POST",
      token: verifier.token,
      body: {
        branchOrganisationId: branchId,
        recipients: [{ email: "test-recipient@example.com", name: "Test Recipient", isPrimary: true }],
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.status).toBe("not_submitted");
    expect(created.body.recipients).toHaveLength(1);

    const sendable = await api(`/api/cases/${loanCase.id}/submissions/${created.body.id}/sendable-documents`, {
      token: verifier.token,
    });
    expect(sendable.status, JSON.stringify(sendable.body)).toBe(200);
    const documentIds = sendable.body.map((d: any) => d.documentId);
    expect(documentIds.length).toBeGreaterThan(0);
    // Every requirement was verified in `aReadyCase` — none should be blocked.
    expect(sendable.body.every((d: any) => !d.blockedBecause)).toBe(true);

    const prepared = await api(`/api/cases/${loanCase.id}/submissions/${created.body.id}/package/prepare`, {
      method: "POST",
      token: verifier.token,
      body: { documentIds },
    });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    expect(prepared.body.plan.emails.length).toBeGreaterThan(0);

    const sent = await api(`/api/cases/${loanCase.id}/submissions/${created.body.id}/package/send`, {
      method: "POST",
      token: verifier.token,
      body: { documentIds, fingerprint: prepared.body.fingerprint },
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.failedCount).toBe(0);
    expect(sent.body.sentCount).toBeGreaterThan(0);

    // Durable in Postgres: package, recipient, email and document rows, with
    // a provider message id — proof the send went through mail-client.ts and
    // the real (capture) mail-server.mjs, not a stub.
    const { rows: packageRows } = await pool.query(
      `select status, document_count from submission_package where submission_id = $1`,
      [created.body.id],
    );
    expect(packageRows[0].status).toBe("sent");
    expect(packageRows[0].document_count).toBe(documentIds.length);

    const { rows: emailRows } = await pool.query(
      `select sp.status, sp.provider_message_id from submission_package_email sp
         join submission_package p on p.id = sp.submission_package_id
        where p.submission_id = $1`,
      [created.body.id],
    );
    for (const row of emailRows) {
      expect(row.status).toBe("sent");
      expect(row.provider_message_id).toBeTruthy();
    }

    const { rows: docRows } = await pool.query(
      `select count(*)::int as n from submission_package_document spd
         join submission_package p on p.id = spd.submission_package_id
        where p.submission_id = $1`,
      [created.body.id],
    );
    expect(docRows[0].n).toBe(documentIds.length);

    // Only after the successful send does the case advance — the existing
    // system transition, not a new mechanism.
    const finalCase = await api(`/api/cases/${loanCase.id}`, { token: owner.token });
    expect(finalCase.body.stage).toBe("submitted");

    const { rows: submissionRow } = await pool.query(
      `select status, submitted_at, submitted_by from submission where id = $1`,
      [created.body.id],
    );
    expect(submissionRow[0].status).toBe("submitted");
    expect(submissionRow[0].submitted_at).not.toBeNull();
    expect(submissionRow[0].submitted_by).toBe(verifier.userId);

    // Audit events for the submission, each email, and the package.
    const events = await eventsFor(loanCase.id);
    const eventTypes = events.map((e) => e.event_type);
    expect(eventTypes).toContain("submission.created");
    expect(eventTypes).toContain("submission.email_sent");
    expect(eventTypes).toContain("submission.documents_sent");
    expect(eventTypes).toContain("case.stage_changed");
  });

  it("keeps two submissions on the same case independent", async () => {
    const owner = await signInAs("telecaller");
    const verifier = await signInAs("login_executive");
    const loanCase = await aReadyCase(owner, verifier);
    const [branchA, branchB] = await twoBranchIds(owner.token);

    const submissionA = await api(`/api/cases/${loanCase.id}/submissions`, {
      method: "POST",
      token: verifier.token,
      body: { branchOrganisationId: branchA, recipients: [{ email: "bank-a@example.com" }] },
    });
    const submissionB = await api(`/api/cases/${loanCase.id}/submissions`, {
      method: "POST",
      token: verifier.token,
      body: { branchOrganisationId: branchB, recipients: [{ email: "bank-b@example.com" }] },
    });
    expect(submissionA.status, JSON.stringify(submissionA.body)).toBe(200);
    expect(submissionB.status, JSON.stringify(submissionB.body)).toBe(200);

    const sendable = await api(`/api/cases/${loanCase.id}/submissions/${submissionA.body.id}/sendable-documents`, {
      token: verifier.token,
    });
    const documentIds = sendable.body.map((d: any) => d.documentId);
    const prepared = await api(`/api/cases/${loanCase.id}/submissions/${submissionA.body.id}/package/prepare`, {
      method: "POST",
      token: verifier.token,
      body: { documentIds },
    });
    const sent = await api(`/api/cases/${loanCase.id}/submissions/${submissionA.body.id}/package/send`, {
      method: "POST",
      token: verifier.token,
      body: { documentIds, fingerprint: prepared.body.fingerprint },
    });
    expect(sent.body.failedCount).toBe(0);

    // Bank A dispatched; bank B is untouched — one case may be submitted to
    // one bank and (eventually) rejected by another, independently.
    const { rows } = await pool.query(`select id, status from submission where case_id = $1 order by created_at`, [
      loanCase.id,
    ]);
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(submissionA.body.id)).toBe("submitted");
    expect(byId.get(submissionB.body.id)).toBe("not_submitted");
  });

  it("never leaks a raw database error to the client", async () => {
    const owner = await signInAs("telecaller");
    const bogus = await api(`/api/cases/${randomUUID()}/submissions`, { token: owner.token });
    expect(bogus.status).toBe(404);
    expect(bogus.body.message).not.toMatch(/column|relation|syntax|postgres/i);
  });
});

describe("submission.create is required to submit or send", () => {
  it("refuses a telecaller creating a submission on a case they do not own", async () => {
    const owner = await signInAs("telecaller");
    const stranger = await signInAs("telecaller");
    const verifier = await signInAs("login_executive");
    const loanCase = await aReadyCase(owner, verifier);
    const [branchId] = await twoBranchIds(owner.token);

    const attempt = await api(`/api/cases/${loanCase.id}/submissions`, {
      method: "POST",
      token: stranger.token,
      body: { branchOrganisationId: branchId, recipients: [{ email: "test@example.com" }] },
    });
    expect(attempt.status).toBe(404); // non-enumeration, same as documents.ts
  });
});

// ---------------------------------------------------------------------------
// Function-level — deterministic provider control for failure/retry
// ---------------------------------------------------------------------------

function fakeProvider(behavior: (email: OutgoingEmail) => EmailSendResult): EmailProvider & {
  readonly calls: OutgoingEmail[];
} {
  const calls: OutgoingEmail[] = [];
  return {
    name: "fake",
    calls,
    async send(email) {
      calls.push(email);
      return behavior(email);
    },
  };
}

async function setUpReadyCaseWithSubmission(): Promise<{
  actor: Actor;
  caseId: string;
  submissionId: string;
  documentIds: string[];
}> {
  const owner = await signInAs("telecaller");
  const verifier = await signInAs("login_executive");
  const loanCase = await aReadyCase(owner, verifier);
  const [branchId] = await twoBranchIds(owner.token);
  // `submission.create` is a login-desk permission, not a telecaller one —
  // the actor performing every submission call below must hold it.
  const actor = actorFor(verifier, ["login_executive"]);

  const submission = await withActor(null, (client) =>
    createSubmission(client, actor, loanCase.id, {
      branchOrganisationId: branchId,
      recipients: [{ email: "retry-test@example.com" }],
    }),
  );

  const documentIds = await withActor(null, async (client) => {
    const rows = await sendableDocuments(client, actor, loanCase.id, submission.id);
    return rows.map((r) => r.documentId);
  });

  return { actor, caseId: loanCase.id, submissionId: submission.id, documentIds };
}

describe("provider failure and retry — function-level, deterministic providers", () => {
  it("leaves the package failed and the case at ready_for_submission when the provider refuses", async () => {
    const { actor, caseId, submissionId, documentIds } = await setUpReadyCaseWithSubmission();

    const fingerprint = await withActor(null, async (client) => {
      const prepared = await preparePackage(client, actor, caseId, submissionId, { documentIds });
      return prepared.fingerprint;
    });

    const alwaysFails = fakeProvider((email) => ({
      ok: false,
      submissionPackageEmailId: email.submissionPackageEmailId,
      failure: { kind: "unknown", message: "simulated provider failure" },
    }));

    const result = await withActor(null, (client) =>
      sendPackage(client, actor, caseId, submissionId, { documentIds, fingerprint }, alwaysFails),
    );
    expect(result.failedCount).toBeGreaterThan(0);
    expect(result.sentCount).toBe(0);

    const { rows: packageRows } = await pool.query(
      `select status from submission_package where submission_id = $1`,
      [submissionId],
    );
    expect(packageRows[0].status).toBe("failed");

    const { rows: submissionRows } = await pool.query(`select status from submission where id = $1`, [
      submissionId,
    ]);
    expect(submissionRows[0].status).toBe("not_submitted");

    const { rows: caseRows } = await pool.query(`select stage from loan_case where id = $1`, [caseId]);
    expect(caseRows[0].stage).toBe("ready_for_submission");
  });

  it("retry resends only the failed email, and succeeding then advances the case", async () => {
    const { actor, caseId, submissionId, documentIds } = await setUpReadyCaseWithSubmission();

    const fingerprint = await withActor(null, async (client) => {
      const prepared = await preparePackage(client, actor, caseId, submissionId, { documentIds });
      return prepared.fingerprint;
    });

    const alwaysFails = fakeProvider((email) => ({
      ok: false,
      submissionPackageEmailId: email.submissionPackageEmailId,
      failure: { kind: "unknown", message: "simulated provider failure" },
    }));
    const sendResult = await withActor(null, (client) =>
      sendPackage(client, actor, caseId, submissionId, { documentIds, fingerprint }, alwaysFails),
    );
    expect(sendResult.failedCount).toBeGreaterThan(0);

    const { rows: packageRows } = await pool.query(
      `select id from submission_package where submission_id = $1`,
      [submissionId],
    );
    const packageId = packageRows[0].id;

    const succeeds = fakeProvider((email) => ({
      ok: true,
      submissionPackageEmailId: email.submissionPackageEmailId,
      providerMessageId: "retry-message-id",
      sentAt: new Date().toISOString(),
    }));
    const retryResult = await withActor(null, (client) =>
      retryPackage(client, actor, caseId, submissionId, packageId, succeeds),
    );
    expect(retryResult.failedCount).toBe(0);
    expect(retryResult.sentCount).toBeGreaterThan(0);
    // The retry only touched the emails that had failed.
    expect(succeeds.calls.length).toBe(sendResult.failedCount);

    const { rows: caseRows } = await pool.query(`select stage from loan_case where id = $1`, [caseId]);
    expect(caseRows[0].stage).toBe("submitted");

    const { rows: submissionRows } = await pool.query(
      `select status, submitted_at from submission where id = $1`,
      [submissionId],
    );
    expect(submissionRows[0].status).toBe("submitted");
    expect(submissionRows[0].submitted_at).not.toBeNull();
  });

  it("does not call the provider again, and does not duplicate, when retrying a fully-sent package", async () => {
    const { actor, caseId, submissionId, documentIds } = await setUpReadyCaseWithSubmission();

    const fingerprint = await withActor(null, async (client) => {
      const prepared = await preparePackage(client, actor, caseId, submissionId, { documentIds });
      return prepared.fingerprint;
    });

    const succeeds = fakeProvider((email) => ({
      ok: true,
      submissionPackageEmailId: email.submissionPackageEmailId,
      providerMessageId: "first-send-message-id",
      sentAt: new Date().toISOString(),
    }));
    const sendResult = await withActor(null, (client) =>
      sendPackage(client, actor, caseId, submissionId, { documentIds, fingerprint }, succeeds),
    );
    expect(sendResult.failedCount).toBe(0);
    expect(succeeds.calls.length).toBe(sendResult.sentCount);

    const { rows: packageRows } = await pool.query(
      `select id from submission_package where submission_id = $1`,
      [submissionId],
    );
    const packageId = packageRows[0].id;

    const { rows: beforeEmailRows } = await pool.query(
      `select provider_message_id, attempt_count from submission_package_email where submission_package_id = $1`,
      [packageId],
    );

    const shouldNeverBeCalled = fakeProvider(() => {
      throw new Error("must not be called — nothing in this package is failed");
    });
    const retryResult = await withActor(null, (client) =>
      retryPackage(client, actor, caseId, submissionId, packageId, shouldNeverBeCalled),
    );

    expect(retryResult.sentCount).toBe(0);
    expect(retryResult.failedCount).toBe(0);
    expect(retryResult.message).toContain("Nothing to retry");
    expect(shouldNeverBeCalled.calls.length).toBe(0);

    const { rows: afterEmailRows } = await pool.query(
      `select provider_message_id, attempt_count from submission_package_email where submission_package_id = $1`,
      [packageId],
    );
    expect(afterEmailRows).toEqual(beforeEmailRows);
  });
});
