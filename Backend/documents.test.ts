/**
 * Stage 3C acceptance tests — documents, requirements, verification, progress
 * and the case-readiness transition they now drive.
 *
 * The path this file proves end to end, against real Postgres and the real
 * storage backend: a case opens with real, rule-generated requirements; an
 * uploaded document is durably stored and metadata persists; a human
 * verification satisfies a requirement; progress is computed from that real
 * data; and once nothing is outstanding, the EXISTING transition machine
 * (`@domain/case/transitions`, unmodified) advances the case on its own —
 * exactly the automatic move ADR-019 always specified, now reachable because
 * the guard finally has real inputs (Backend/cases.ts `snapshotOf`).
 *
 * Requires `npm run storage-server` running against a scratch root, same as
 * any other integration test needs Postgres running — see
 * `tests/support/e2e-globalsetup.ts` for the equivalent Playwright wiring.
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

import { createApiServer } from "./api-server.js";
import { pool, withActor } from "./db.js";

let baseUrl: string;
let server: ReturnType<typeof createApiServer>;
let storageServer: ChildProcess;
let storageRoot: string;

/** A throwaway storage-server instance, on the port `AOS_STORAGE_SERVER_URL`
 * (vitest.integration.config.ts) points `storage-client.ts` at — never the
 * office backend on 4319, and never the office disk. */
async function startStorageServer(): Promise<void> {
  storageRoot = mkdtempSync(path.join(tmpdir(), "aos-test-storage-"));
  storageServer = spawn(process.execPath, [path.join(process.cwd(), "Backend", "storage-server.mjs")], {
    env: { ...process.env, AOS_STORAGE_PORT: "4329", AOS_STORAGE_ROOT: storageRoot },
    stdio: "pipe",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://127.0.0.1:4329/health");
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("storage-server did not become healthy in time.");
}

const PASSWORD = "integration-test-password";
const FIXTURE = readFileSync(
  path.join(process.cwd(), "tests", "fixtures", "pan-card.pdf"),
);

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

  const response = await fetch(`${baseUrl}${path_}`, {
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

async function signInAs(role: Role): Promise<Session> {
  const username = await createEmployee(role);
  const { status, body } = await api("/api/auth/login", {
    method: "POST",
    body: { username, password: PASSWORD },
  });
  expect(status, JSON.stringify(body)).toBe(200);
  return { token: body.token, userId: body.user.id };
}

async function anyLoanProductId(): Promise<string> {
  const { rows } = await pool.query(`select id from loan_product limit 1`);
  return rows[0]!.id;
}

async function aCase(session: Session) {
  const customer = await api("/api/customers", {
    method: "POST",
    token: session.token,
    body: {
      fullName: `Applicant ${randomUUID().slice(0, 8)}`,
      phone: "9843012345",
      city: "Coimbatore",
    },
  });
  const created = await api("/api/cases", {
    method: "POST",
    token: session.token,
    body: { applicantId: customer.body.id, loanProductId: await anyLoanProductId() },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body as { id: string; stage: string };
}

async function move(session: Session, caseId: string, stage: string) {
  return await api(`/api/cases/${caseId}/stage`, {
    method: "PUT",
    token: session.token,
    body: { stage },
  });
}

async function toDocumentsPending(session: Session, caseId: string) {
  await move(session, caseId, "contacted");
  const result = await move(session, caseId, "documents_pending");
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

async function upload(session: Session, caseId: string, requirementId: string, fileName = "pan-card.pdf") {
  return await api(`/api/cases/${caseId}/requirements/${requirementId}/documents`, {
    method: "POST",
    token: session.token,
    rawBody: FIXTURE,
    headers: { "Content-Type": "application/pdf", "X-File-Name": fileName },
  });
}

async function decide(session: Session, caseId: string, requirementId: string, decision: string, reason?: string) {
  return await api(`/api/cases/${caseId}/requirements/${requirementId}/decision`, {
    method: "PUT",
    token: session.token,
    body: reason ? { decision, reason } : { decision },
  });
}

beforeAll(async () => {
  await startStorageServer();
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  storageServer.kill();
  rmSync(storageRoot, { recursive: true, force: true });
  await pool.end();
});

describe("requirements are generated from the real case, in Postgres", () => {
  it("gives a fresh case real, mandatory KYC requirements — not an empty checklist", async () => {
    const telecaller = await signInAs("telecaller");
    const loanCase = await aCase(telecaller);
    await toDocumentsPending(telecaller, loanCase.id);

    const listing = await api(`/api/cases/${loanCase.id}/requirements`, { token: telecaller.token });
    expect(listing.status, JSON.stringify(listing.body)).toBe(200);
    expect(listing.body.requirements.length).toBeGreaterThan(0);

    const codes = listing.body.requirements.map((r: any) => r.documentTypeCode);
    // Unconditional KYC rules (Database/migrations/0022) — asked of every
    // signing party regardless of employment type or product.
    expect(codes).toContain("pan_card");
    expect(codes).toContain("aadhaar_card");

    for (const requirement of listing.body.requirements) {
      expect(requirement.status).toBe("pending");
      expect(requirement.document).toBeNull();
    }
    expect(listing.body.progress.percentComplete).toBeLessThan(100);
    expect(listing.body.progress.isReadyForSubmission).toBe(false);
  });

  it("is idempotent — a second read regenerates nothing new", async () => {
    const telecaller = await signInAs("telecaller");
    const loanCase = await aCase(telecaller);
    await toDocumentsPending(telecaller, loanCase.id);

    const first = await api(`/api/cases/${loanCase.id}/requirements`, { token: telecaller.token });
    const second = await api(`/api/cases/${loanCase.id}/requirements`, { token: telecaller.token });
    expect(second.body.requirements.map((r: any) => r.id).sort()).toEqual(
      first.body.requirements.map((r: any) => r.id).sort(),
    );
  });
});

describe("the complete document path: upload, storage, verification, progress, readiness", () => {
  it("takes a real case from zero documents to an automatic stage advance", async () => {
    const telecaller = await signInAs("telecaller");
    const loginExecutive = await signInAs("login_executive");
    const loanCase = await aCase(telecaller);
    await toDocumentsPending(telecaller, loanCase.id);

    const listing = await api(`/api/cases/${loanCase.id}/requirements`, { token: telecaller.token });
    const requirements: any[] = listing.body.requirements;
    expect(requirements.length).toBeGreaterThan(0);

    // 1. Upload — the telecaller who owns the case may collect documents.
    for (const requirement of requirements) {
      const result = await upload(telecaller, loanCase.id, requirement.id);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.status).toBe("received");
      expect(result.body.document).not.toBeNull();
      expect(result.body.document.fileSizeBytes).toBe(FIXTURE.byteLength);
    }

    // 2. Storage is durable and independent of the request that wrote it —
    // fetched back through the download route as a different actor.
    const afterUpload = await api(`/api/cases/${loanCase.id}/requirements`, { token: telecaller.token });
    const uploadedDoc = afterUpload.body.requirements[0].document;
    const download = await api(`/api/documents/${uploadedDoc.id}/download`, {
      token: loginExecutive.token,
    });
    expect(download.status).toBe(200);
    expect(Buffer.isBuffer(download.body)).toBe(true);
    expect((download.body as Buffer).equals(FIXTURE)).toBe(true);

    // 3. A telecaller may not verify — document.verify is LE/MG only.
    const firstRequirementId = requirements[0].id;
    const refused = await decide(telecaller, loanCase.id, firstRequirementId, "verified");
    expect(refused.status).toBe(403);
    expect(refused.body.message).toContain("document.verify");

    // 4. The login executive verifies every requirement.
    for (const requirement of requirements) {
      const result = await decide(loginExecutive, loanCase.id, requirement.id, "verified");
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.status).toBe("verified");
      expect(result.body.document.verifiedByUserId).toBe(loginExecutive.userId);
    }

    // 5. Progress is authoritative and complete.
    const complete = await api(`/api/cases/${loanCase.id}/requirements`, { token: telecaller.token });
    expect(complete.body.progress.percentComplete).toBe(100);
    expect(complete.body.progress.outstandingCount).toBe(0);
    expect(complete.body.progress.isReadyForSubmission).toBe(true);

    // 6. The EXISTING transition machine moved the case on its own — nobody
    // clicked "Move stage". This is `evaluateTransition`, unmodified,
    // finally given a real `outstandingRequirementCount`.
    const finalCase = await api(`/api/cases/${loanCase.id}`, { token: telecaller.token });
    expect(finalCase.body.stage).toBe("ready_for_submission");
  });

  it("rejects a document with a reason, and does not let the case advance", async () => {
    const telecaller = await signInAs("telecaller");
    const loginExecutive = await signInAs("login_executive");
    const loanCase = await aCase(telecaller);
    await toDocumentsPending(telecaller, loanCase.id);

    const listing = await api(`/api/cases/${loanCase.id}/requirements`, { token: telecaller.token });
    const requirements: any[] = listing.body.requirements;

    for (const requirement of requirements) {
      await upload(telecaller, loanCase.id, requirement.id);
    }

    const withoutReason = await decide(loginExecutive, loanCase.id, requirements[0].id, "rejected");
    expect(withoutReason.status).toBe(400);

    const rejected = await decide(
      loginExecutive,
      loanCase.id,
      requirements[0].id,
      "rejected",
      "Photo of the PAN is blurred — please reupload.",
    );
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.status).toBe("rejected");
    expect(rejected.body.document).not.toBeNull(); // the document itself is kept, just not accepted

    for (const requirement of requirements.slice(1)) {
      await decide(loginExecutive, loanCase.id, requirement.id, "verified");
    }

    const progress = await api(`/api/cases/${loanCase.id}/requirements`, { token: telecaller.token });
    expect(progress.body.progress.rejectedCount).toBe(1);
    expect(progress.body.progress.isReadyForSubmission).toBe(false);

    const stillPending = await api(`/api/cases/${loanCase.id}`, { token: telecaller.token });
    expect(stillPending.body.stage).toBe("documents_pending");

    // Reupload against the same requirement clears the rejection.
    const reupload = await upload(telecaller, loanCase.id, requirements[0].id, "pan-card-v2.pdf");
    expect(reupload.status).toBe(200);
    expect(reupload.body.status).toBe("received");
    expect(reupload.body.document.version).toBe(2);
  });

  it("refuses to verify a requirement with nothing uploaded", async () => {
    const telecaller = await signInAs("telecaller");
    const loginExecutive = await signInAs("login_executive");
    const loanCase = await aCase(telecaller);
    await toDocumentsPending(telecaller, loanCase.id);

    const listing = await api(`/api/cases/${loanCase.id}/requirements`, { token: telecaller.token });
    const requirement = listing.body.requirements[0];

    const attempt = await decide(loginExecutive, loanCase.id, requirement.id, "verified");
    expect(attempt.status).toBe(409);
  });

  it("keeps one telecaller from uploading against another's case", async () => {
    const owner = await signInAs("telecaller");
    const stranger = await signInAs("telecaller");
    const loanCase = await aCase(owner);
    await toDocumentsPending(owner, loanCase.id);

    const listing = await api(`/api/cases/${loanCase.id}/requirements`, { token: owner.token });
    const requirement = listing.body.requirements[0];

    const attempt = await upload(stranger, loanCase.id, requirement.id);
    expect(attempt.status).toBe(404); // 404, not 403 — the same non-enumeration rule as cases.ts
  });

  it("is visible to a second session immediately — no per-browser state", async () => {
    const telecaller = await signInAs("telecaller");
    const manager = await signInAs("manager");
    const loanCase = await aCase(telecaller);
    await toDocumentsPending(telecaller, loanCase.id);

    const listing = await api(`/api/cases/${loanCase.id}/requirements`, { token: telecaller.token });
    const requirement = listing.body.requirements[0];
    await upload(telecaller, loanCase.id, requirement.id);

    // A manager, in effect a second PC/session that never touched the
    // telecaller's browser, reads the same uploaded document straight from
    // Postgres.
    const seenByManager = await api(`/api/cases/${loanCase.id}/requirements`, {
      token: manager.token,
    });
    const same = seenByManager.body.requirements.find((r: any) => r.id === requirement.id);
    expect(same.document).not.toBeNull();
    expect(same.status).toBe("received");
  });

  it("restores real progress on the case list — no fake-store number", async () => {
    const telecaller = await signInAs("telecaller");
    const loanCase = await aCase(telecaller);

    const beforeCollecting = await api("/api/cases", { token: telecaller.token });
    const freshRow = beforeCollecting.body.find((c: any) => c.id === loanCase.id);
    // Nothing is due yet at `new` (ADR-020) — zero applicable, not a lie about
    // completeness.
    expect(freshRow.progress.applicableCount).toBe(0);

    await toDocumentsPending(telecaller, loanCase.id);
    const listing = await api(`/api/cases/${loanCase.id}/requirements`, { token: telecaller.token });
    await upload(telecaller, loanCase.id, listing.body.requirements[0].id);

    const afterOneUpload = await api("/api/cases", { token: telecaller.token });
    const row = afterOneUpload.body.find((c: any) => c.id === loanCase.id);
    expect(row.progress.applicableCount).toBeGreaterThan(0);
    expect(row.progress.percentComplete).toBeLessThan(100); // received, not yet verified
  });

  it("never leaks a raw database error to the client", async () => {
    const telecaller = await signInAs("telecaller");
    const loanCase = await aCase(telecaller);
    await toDocumentsPending(telecaller, loanCase.id);

    const bogus = await api(
      `/api/cases/${loanCase.id}/requirements/${randomUUID()}/documents`,
      {
        method: "POST",
        token: telecaller.token,
        rawBody: FIXTURE,
        headers: { "X-File-Name": "x.pdf" },
      },
    );
    expect(bogus.status).toBe(404);
    expect(bogus.body.message).not.toMatch(/column|relation|syntax|postgres/i);
  });
});
