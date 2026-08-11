/**
 * Phase 5 — loan outcome tracking, over real Postgres and real HTTP.
 *
 * Starts where `submissions.test.ts` ends: a submission that has actually
 * been dispatched (`status = 'submitted'`). Everything below drives it
 * through `under_process`, `query_raised`, `eligibility_received`,
 * `sanctioned`, `rejected`, `withdrawn` and `disbursed`, and the offer
 * workflow (`Backend/submissions.ts`'s `updateSubmissionStatus`,
 * `raiseQuery`, `answerQuery`, `recordOffer`, `acceptOffer`), the same
 * two-server-process harness (`storage-server.mjs`, `mail-server.mjs` in
 * capture mode) `submissions.test.ts` already established.
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

async function startStorageServer(): Promise<void> {
  storageRoot = mkdtempSync(path.join(tmpdir(), "aos-test-storage-"));
  storageServer = spawn(process.execPath, [path.join(process.cwd(), "Backend", "storage-server.mjs")], {
    env: { ...process.env, AOS_STORAGE_PORT: "4329", AOS_STORAGE_ROOT: storageRoot },
    stdio: "pipe",
  });
  await waitHealthy("http://127.0.0.1:4329/health");
}

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

async function oneBranchId(token: string): Promise<string> {
  const lenders = await api("/api/lenders", { token });
  expect(lenders.status, JSON.stringify(lenders.body)).toBe(200);
  const branches = lenders.body.flatMap((lender: any) => lender.branches);
  expect(branches.length).toBeGreaterThanOrEqual(1);
  return branches[0].id;
}

async function twoBranchIds(token: string): Promise<[string, string]> {
  const lenders = await api("/api/lenders", { token });
  expect(lenders.status, JSON.stringify(lenders.body)).toBe(200);
  const branches = lenders.body.flatMap((lender: any) => lender.branches);
  expect(branches.length).toBeGreaterThanOrEqual(2);
  return [branches[0].id, branches[1].id];
}

async function eventsFor(caseId: string): Promise<{ event_type: string; entity_type: string; entity_id: string }[]> {
  const { rows } = await pool.query(
    `select event_type, entity_type, entity_id from event where case_id = $1 order by occurred_at`,
    [caseId],
  );
  return rows;
}

async function anyActiveRejectionReasonId(): Promise<string> {
  const { rows } = await pool.query(`select id from rejection_reason where is_active limit 1`);
  return rows[0]!.id;
}

/** Dispatches a submission on `branchId` all the way to `status = 'submitted'`
 * through the real send flow — the one path `submission.status` can ever
 * leave `not_submitted` through. Every Phase 5 test starts here. */
async function aSubmittedSubmission(
  verifier: Session,
  caseId: string,
  branchId: string,
): Promise<{ id: string }> {
  const created = await api(`/api/cases/${caseId}/submissions`, {
    method: "POST",
    token: verifier.token,
    body: {
      branchOrganisationId: branchId,
      recipients: [{ email: `recipient-${randomUUID().slice(0, 6)}@example.com`, isPrimary: true }],
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const submissionId = created.body.id;

  const sendable = await api(`/api/cases/${caseId}/submissions/${submissionId}/sendable-documents`, {
    token: verifier.token,
  });
  const documentIds = sendable.body.map((d: any) => d.documentId);

  const prepared = await api(`/api/cases/${caseId}/submissions/${submissionId}/package/prepare`, {
    method: "POST",
    token: verifier.token,
    body: { documentIds },
  });

  const sent = await api(`/api/cases/${caseId}/submissions/${submissionId}/package/send`, {
    method: "POST",
    token: verifier.token,
    body: { documentIds, fingerprint: prepared.body.fingerprint },
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);

  return { id: submissionId };
}

async function recordOffer(verifier: Session, caseId: string, submissionId: string, amount = 1_000_000): Promise<any> {
  return await api(`/api/cases/${caseId}/submissions/${submissionId}/offers`, {
    method: "POST",
    token: verifier.token,
    body: { sanctionedAmount: amount, interestRate: 9.5, tenureMonths: 120 },
  });
}

async function setStatus(
  verifier: Session,
  caseId: string,
  submissionId: string,
  status: string,
  extra?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return await api(`/api/cases/${caseId}/submissions/${submissionId}/status`, {
    method: "PATCH",
    token: verifier.token,
    body: { status, ...extra },
  });
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

describe("submission status lattice", () => {
  it("walks submitted -> under_process -> query_raised -> under_process -> eligibility_received -> sanctioned -> disbursed", async () => {
    const owner = await signInAs("telecaller");
    const verifier = await signInAs("login_executive");
    const loanCase = await aReadyCase(owner, verifier);
    const branchId = await oneBranchId(verifier.token);
    const submission = await aSubmittedSubmission(verifier, loanCase.id, branchId);

    const underProcess = await setStatus(verifier, loanCase.id, submission.id, "under_process");
    expect(underProcess.status, JSON.stringify(underProcess.body)).toBe(200);
    expect(underProcess.body.status).toBe("under_process");

    const raised = await api(`/api/cases/${loanCase.id}/submissions/${submission.id}/queries`, {
      method: "POST",
      token: verifier.token,
      body: { question: "Please provide the latest 6-month bank statement." },
    });
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);
    expect(raised.body.status).toBe("query_raised");
    expect(raised.body.queries).toHaveLength(1);
    const queryId = raised.body.queries[0].id;

    const answered = await api(`/api/cases/${loanCase.id}/submissions/${submission.id}/queries/${queryId}/answer`, {
      method: "PUT",
      token: verifier.token,
      body: { answer: "Statement attached in the earlier package." },
    });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body.status).toBe("under_process");
    expect(answered.body.queries[0].answeredAt).not.toBeNull();

    const eligible = await setStatus(verifier, loanCase.id, submission.id, "eligibility_received");
    expect(eligible.status, JSON.stringify(eligible.body)).toBe(200);

    // Sanction requires an offer (BR-023) — refused first, then allowed.
    const refusedSanction = await setStatus(verifier, loanCase.id, submission.id, "sanctioned");
    expect(refusedSanction.status).toBe(409);

    const offer = await recordOffer(verifier, loanCase.id, submission.id);
    expect(offer.status, JSON.stringify(offer.body)).toBe(200);
    expect(offer.body.offers).toHaveLength(1);

    const sanctioned = await setStatus(verifier, loanCase.id, submission.id, "sanctioned");
    expect(sanctioned.status, JSON.stringify(sanctioned.body)).toBe(200);
    expect(sanctioned.body.status).toBe("sanctioned");

    // The case advances automatically — never a manual "Move stage" choice.
    const afterSanction = await api(`/api/cases/${loanCase.id}`, { token: owner.token });
    expect(afterSanction.body.stage).toBe("sanctioned");

    const disbursed = await setStatus(verifier, loanCase.id, submission.id, "disbursed");
    expect(disbursed.status, JSON.stringify(disbursed.body)).toBe(200);
    expect(disbursed.body.status).toBe("disbursed");

    const afterDisbursement = await api(`/api/cases/${loanCase.id}`, { token: owner.token });
    expect(afterDisbursement.body.stage).toBe("disbursed");

    const events = await eventsFor(loanCase.id);
    const eventTypes = events.map((e) => e.event_type);
    expect(eventTypes).toContain("submission.under_process");
    expect(eventTypes).toContain("submission.query_raised");
    expect(eventTypes).toContain("submission.query_answered");
    expect(eventTypes).toContain("submission.eligibility_received");
    expect(eventTypes).toContain("offer.recorded");
    expect(eventTypes).toContain("submission.sanctioned");
    expect(eventTypes).toContain("submission.disbursed");
    // One case.stage_changed per real step: submitted was already recorded by
    // the send; sanctioned and disbursed are each their own event.
    expect(eventTypes.filter((t) => t === "case.stage_changed").length).toBeGreaterThanOrEqual(3);
  });

  it("rejects a submission only with a valid reason, and never moves the case backwards", async () => {
    const owner = await signInAs("telecaller");
    const verifier = await signInAs("login_executive");
    const loanCase = await aReadyCase(owner, verifier);
    const branchId = await oneBranchId(verifier.token);
    const submission = await aSubmittedSubmission(verifier, loanCase.id, branchId);

    const withoutReason = await setStatus(verifier, loanCase.id, submission.id, "rejected");
    expect(withoutReason.status).toBe(400);

    const reasonId = await anyActiveRejectionReasonId();
    const rejected = await setStatus(verifier, loanCase.id, submission.id, "rejected", {
      rejectionReasonId: reasonId,
      bankReasonText: "Insufficient documentation on file",
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.status).toBe("rejected");
    expect(rejected.body.rejectionReasonId).toBe(reasonId);

    // The case stays at `submitted` — a rejection is one bank's outcome, not
    // the case's.
    const afterReject = await api(`/api/cases/${loanCase.id}`, { token: owner.token });
    expect(afterReject.body.stage).toBe("submitted");

    // Terminal: no further transition is legal.
    const deadEnd = await setStatus(verifier, loanCase.id, submission.id, "under_process");
    expect(deadEnd.status).toBe(409);
  });

  it("refuses an illegal skip even though the frontend would never offer the button", async () => {
    const owner = await signInAs("telecaller");
    const verifier = await signInAs("login_executive");
    const loanCase = await aReadyCase(owner, verifier);
    const branchId = await oneBranchId(verifier.token);
    const submission = await aSubmittedSubmission(verifier, loanCase.id, branchId);

    const skip = await setStatus(verifier, loanCase.id, submission.id, "disbursed");
    expect(skip.status).toBe(409);
  });

  it("enforces authorization server-side regardless of what the UI shows", async () => {
    const owner = await signInAs("telecaller");
    const verifier = await signInAs("login_executive");
    const loanCase = await aReadyCase(owner, verifier);
    const branchId = await oneBranchId(verifier.token);
    const submission = await aSubmittedSubmission(verifier, loanCase.id, branchId);

    // Telecaller holds no `submission.update_status` (Docs/Permission Matrix.md).
    const refused = await setStatus(owner, loanCase.id, submission.id, "under_process");
    expect(refused.status).toBe(403);
  });
});

describe("multi-bank behaviour", () => {
  it("keeps two banks on the same case independent — one rejection does not touch the other", async () => {
    const owner = await signInAs("telecaller");
    const verifier = await signInAs("login_executive");
    const loanCase = await aReadyCase(owner, verifier);
    const [branchA, branchB] = await twoBranchIds(verifier.token);
    const subA = await aSubmittedSubmission(verifier, loanCase.id, branchA);
    const subB = await aSubmittedSubmission(verifier, loanCase.id, branchB);

    const reasonId = await anyActiveRejectionReasonId();
    const rejected = await setStatus(verifier, loanCase.id, subA.id, "rejected", { rejectionReasonId: reasonId });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);

    const listing = await api(`/api/cases/${loanCase.id}/submissions`, { token: verifier.token });
    const bRow = listing.body.find((s: any) => s.id === subB.id);
    expect(bRow.status).toBe("submitted");
  });

  it("accepting one offer withdraws every other live submission on the case, each withdrawal audited", async () => {
    const owner = await signInAs("telecaller");
    const verifier = await signInAs("login_executive");
    const loanCase = await aReadyCase(owner, verifier);
    const [branchA, branchB] = await twoBranchIds(verifier.token);
    const subA = await aSubmittedSubmission(verifier, loanCase.id, branchA);
    const subB = await aSubmittedSubmission(verifier, loanCase.id, branchB);

    await setStatus(verifier, loanCase.id, subA.id, "under_process");
    await setStatus(verifier, loanCase.id, subA.id, "eligibility_received");
    const offerA = await recordOffer(verifier, loanCase.id, subA.id, 2_000_000);
    const offerId = offerA.body.offers[0].id;
    await setStatus(verifier, loanCase.id, subA.id, "sanctioned");

    const accepted = await api(`/api/cases/${loanCase.id}/submissions/${subA.id}/offers/${offerId}/accept`, {
      method: "PUT",
      token: verifier.token,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    const listing = await api(`/api/cases/${loanCase.id}/submissions`, { token: verifier.token });
    const bRow = listing.body.find((s: any) => s.id === subB.id);
    expect(bRow.status).toBe("withdrawn");
    const aRow = listing.body.find((s: any) => s.id === subA.id);
    expect(aRow.status).toBe("sanctioned");
    expect(aRow.offers.find((o: any) => o.id === offerId).isAccepted).toBe(true);

    const events = await eventsFor(loanCase.id);
    const withdrawalEvents = events.filter(
      (e) => e.event_type === "submission.withdrawn" && e.entity_id === subB.id,
    );
    expect(withdrawalEvents).toHaveLength(1);
    expect(events.map((e) => e.event_type)).toContain("offer.accepted");
  });

  it("enforces one disbursed submission per case (BR-022)", async () => {
    const owner = await signInAs("telecaller");
    const verifier = await signInAs("login_executive");
    const loanCase = await aReadyCase(owner, verifier);
    const [branchA, branchB] = await twoBranchIds(verifier.token);
    const subA = await aSubmittedSubmission(verifier, loanCase.id, branchA);
    const subB = await aSubmittedSubmission(verifier, loanCase.id, branchB);

    for (const sub of [subA, subB]) {
      await setStatus(verifier, loanCase.id, sub.id, "under_process");
      await setStatus(verifier, loanCase.id, sub.id, "eligibility_received");
      await recordOffer(verifier, loanCase.id, sub.id);
      await setStatus(verifier, loanCase.id, sub.id, "sanctioned");
    }

    const firstDisbursed = await setStatus(verifier, loanCase.id, subA.id, "disbursed");
    expect(firstDisbursed.status, JSON.stringify(firstDisbursed.body)).toBe(200);

    const secondDisbursed = await setStatus(verifier, loanCase.id, subB.id, "disbursed");
    expect(secondDisbursed.status).toBe(409);
  });
});

describe("persistence", () => {
  it("survives a fresh request — outcome state is read back from Postgres, not memory", async () => {
    const owner = await signInAs("telecaller");
    const verifier = await signInAs("login_executive");
    const loanCase = await aReadyCase(owner, verifier);
    const branchId = await oneBranchId(verifier.token);
    const submission = await aSubmittedSubmission(verifier, loanCase.id, branchId);

    await setStatus(verifier, loanCase.id, submission.id, "under_process");
    await setStatus(verifier, loanCase.id, submission.id, "eligibility_received");
    await recordOffer(verifier, loanCase.id, submission.id, 3_000_000);

    const { rows } = await pool.query(
      `select status from submission where id = $1`,
      [submission.id],
    );
    expect(rows[0].status).toBe("eligibility_received");

    const freshSession = await signInAs("login_executive");
    const listing = await api(`/api/cases/${loanCase.id}/submissions`, { token: freshSession.token });
    const row = listing.body.find((s: any) => s.id === submission.id);
    expect(row.status).toBe("eligibility_received");
    expect(row.offers).toHaveLength(1);
    expect(row.offers[0].sanctionedAmount).toBe(3_000_000);
  });
});
