import { describe, expect, it, vi } from "vitest";

import type {
  EmailProvider,
  EmailSendResult,
  OutgoingEmail,
} from "@domain/communications/index.js";

import { createStorageModule } from "./storage.mock.js";

/**
 * Sending a case's documents to a banker, at the store boundary (ADR-039).
 *
 * WHAT IS REAL HERE AND WHAT IS NOT.
 *
 * Real: the case, its requirements, the uploads, the verification, the
 * permission checks, the batching, the composition, the package/email/document
 * records and the event log. All of it is the code that runs in the browser.
 *
 * Not real: the mail provider and object storage. Storage is the in-memory
 * fake `store.test.ts` already uses, and the provider is `RecordingProvider`
 * below — a stand-in that records what it was asked to send and can be told to
 * fail on a chosen email.
 *
 * NO REAL EMAIL IS SENT BY ANY TEST IN THIS FILE, and none should ever be
 * added. Delivery to an actual mailbox needs a credential, is not
 * deterministic, and would mail a real bank from a test run. What can be
 * asserted without one is everything above, which is where the business rules
 * live; the provider contract itself is asserted against the interface.
 */

function installLocalStoragePolyfill(): void {
  const backing = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => (backing.has(key) ? (backing.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
    clear: () => backing.clear(),
    key: () => null,
    get length() {
      return backing.size;
    },
  } as Storage;
}

installLocalStoragePolyfill();

vi.doMock("./storage.js", () => createStorageModule());
// `store.ts` imports the HTTP provider at module load. Nothing in this file
// uses it — every call passes an explicit provider — but the module must not
// try to read `import.meta.env` or reach a socket just to be imported.
vi.doMock("./mail.js", () => ({
  emailProvider: {
    name: "unused-in-tests",
    async send(email: OutgoingEmail): Promise<EmailSendResult> {
      throw new Error(`No provider was passed for ${email.submissionPackageEmailId}.`);
    },
  } satisfies EmailProvider,
  mailBackendHealth: async () => {
    throw new Error("not used in tests");
  },
}));

const {
  createCase,
  createSubmission,
  getDb,
  moveStage,
  packageDocumentsOf,
  packageEmailsOf,
  packageRecipientsOf,
  packagesFor,
  prepareDocumentPackage,
  rejectDocument,
  resetDatabase,
  retryDocumentPackage,
  sendDocumentPackage,
  sendableDocumentsFor,
  uploadDocument,
  verifyDocument,
} = await import("./store.js");

// ---------------------------------------------------------------------------
// A provider that records rather than sends.
// ---------------------------------------------------------------------------

class RecordingProvider implements EmailProvider {
  readonly name = "recording";
  readonly sent: OutgoingEmail[] = [];
  readonly attempts: OutgoingEmail[] = [];

  /** Sequence numbers that should fail, until `heal()` is called. */
  private failing = new Set<number>();
  private failureKind: "network" | "authentication" | "invalid_recipient" = "network";

  failSequence(sequence: number, kind: "network" | "authentication" | "invalid_recipient" = "network"): void {
    this.failing.add(sequence);
    this.failureKind = kind;
  }

  heal(): void {
    this.failing.clear();
  }

  async send(email: OutgoingEmail): Promise<EmailSendResult> {
    this.attempts.push(email);

    // The email's own sequence, read off its subject rather than passed in —
    // which incidentally asserts the subject really does carry it.
    const match = /\((\d+)\/(\d+)\)/.exec(email.subject);
    const sequence = match ? Number(match[1]) : 1;

    if (this.failing.has(sequence)) {
      return {
        ok: false,
        submissionPackageEmailId: email.submissionPackageEmailId,
        failure: { kind: this.failureKind, message: "Simulated provider failure." },
      };
    }

    this.sent.push(email);
    return {
      ok: true,
      submissionPackageEmailId: email.submissionPackageEmailId,
      providerMessageId: `msg_${this.sent.length}`,
      sentAt: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Fixture: a case with verified documents and a bank on it.
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;

function userWithRole(role: string): string {
  const id = getDb().users.find((user) => user.roles.includes(role as never))?.id;
  if (!id) throw new Error(`test setup: expected a seeded ${role}`);
  return id;
}

interface Fixture {
  caseId: string;
  submissionId: string;
  loginExecutiveId: string;
  telecallerId: string;
  branchId: string;
}

/**
 * A case at documents_pending with `count` uploaded documents, all verified,
 * and one bank added.
 *
 * `sizes` lets a test choose file sizes, which is how multi-batch splitting is
 * exercised through the real store rather than only in the domain layer.
 */
function setup(options?: { sizes?: readonly number[] }): Fixture {
  resetDatabase();
  const db = getDb();

  const telecallerId = userWithRole("telecaller");
  const loginExecutiveId = userWithRole("login_executive");
  const productId = db.loanProducts.find((product) => product.code === "bl_machinery")?.id
    ?? db.loanProducts[0]?.id;
  if (!productId) throw new Error("test setup: expected a seeded product");

  const caseId = createCase(
    { newApplicantName: "Ravi Kumar", loanProductId: productId },
    telecallerId,
  );
  for (const stage of ["contacted", "documents_pending"] as const) {
    const moved = moveStage(caseId, stage, telecallerId);
    if (!moved.ok) throw new Error(`test setup: ${moved.message}`);
  }

  const branch = getDb().organisations.find((org) => org.roles.includes("branch"));
  if (!branch) throw new Error("test setup: expected a seeded branch");

  const created = createSubmission(
    {
      caseId,
      branchOrganisationId: branch.id,
      recipients: [
        { email: "karthik@examplebank.com", name: "Karthik V", kind: "to", isPrimary: true },
        { email: "homeloans.cbe@examplebank.com", kind: "cc" },
      ],
    },
    loginExecutiveId,
  );
  if (!created.ok) throw new Error(`test setup: ${created.message}`);

  const submissionId = getDb().submissions.find((s) => s.caseId === caseId)?.id;
  if (!submissionId) throw new Error("test setup: expected a submission");

  return { caseId, submissionId, loginExecutiveId, telecallerId, branchId: branch.id };
}

/** Upload against the first `count` pending requirements, sized as given. */
async function uploadAndVerify(
  fixture: Fixture,
  count: number,
  sizes?: readonly number[],
): Promise<string[]> {
  const pending = getDb()
    .requirements.filter((r) => r.caseId === fixture.caseId && r.status === "pending")
    .slice(0, count);
  if (pending.length < count) {
    throw new Error(`test setup: only ${pending.length} pending requirements, wanted ${count}`);
  }

  const requirementIds: string[] = [];
  for (const [index, requirement] of pending.entries()) {
    const size = sizes?.[index] ?? 1024;
    const uploaded = await uploadDocument(
      requirement.id,
      {
        name: `document-${index + 1}.pdf`,
        // The RECORDED size drives batching; the bytes only have to exist.
        size,
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        contentType: "application/pdf",
      },
      fixture.telecallerId,
    );
    if (!uploaded.ok) throw new Error(`test setup: ${uploaded.message}`);

    const verified = verifyDocument(requirement.id, fixture.loginExecutiveId);
    if (!verified.ok) throw new Error(`test setup: ${verified.message}`);
    requirementIds.push(requirement.id);
  }
  return requirementIds;
}

function verifiedDocumentIds(fixture: Fixture): string[] {
  return sendableDocumentsFor(fixture.caseId)
    .filter((row) => row.blockedBecause === undefined)
    .map((row) => row.documentId);
}

function prepareFor(fixture: Fixture, documentIds: readonly string[], actorUserId?: string) {
  return prepareDocumentPackage(
    {
      submissionId: fixture.submissionId,
      documentIds,
      recipients: [
        { email: "karthik@examplebank.com", name: "Karthik V", kind: "to", isPrimary: true },
        { email: "homeloans.cbe@examplebank.com", kind: "cc" },
      ],
    },
    actorUserId ?? fixture.loginExecutiveId,
  );
}

async function sendFor(
  fixture: Fixture,
  documentIds: readonly string[],
  provider: EmailProvider,
  actorUserId?: string,
) {
  const prepared = prepareFor(fixture, documentIds, actorUserId);
  if (!prepared.ok) throw new Error(`expected a plan: ${prepared.message}`);
  return sendDocumentPackage(
    {
      submissionId: fixture.submissionId,
      documentIds,
      recipients: [
        { email: "karthik@examplebank.com", name: "Karthik V", kind: "to", isPrimary: true },
        { email: "homeloans.cbe@examplebank.com", kind: "cc" },
      ],
      fingerprint: prepared.prepared.fingerprint,
    },
    actorUserId ?? fixture.loginExecutiveId,
    provider,
  );
}

// ---------------------------------------------------------------------------
// Selection.
// ---------------------------------------------------------------------------

describe("what may be sent", () => {
  it("offers a verified document", async () => {
    const fixture = setup();
    await uploadAndVerify(fixture, 2);

    const rows = sendableDocumentsFor(fixture.caseId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.blockedBecause).toBeUndefined();
      expect(row.verifiedAt).toBeDefined();
    }
  });

  it("shows an uploaded-but-unverified document, disabled, with the reason", async () => {
    const fixture = setup();
    await uploadAndVerify(fixture, 1);

    // A second upload that nobody has verified.
    const pending = getDb().requirements.find(
      (r) => r.caseId === fixture.caseId && r.status === "pending",
    );
    if (!pending) throw new Error("expected another pending requirement");
    await uploadDocument(
      pending.id,
      { name: "unverified.pdf", size: 2048, bytes: new Uint8Array([1]) },
      fixture.telecallerId,
    );

    const rows = sendableDocumentsFor(fixture.caseId);
    const unverified = rows.find((row) => row.fileName === "unverified.pdf");
    expect(unverified?.blockedBecause).toContain("Not verified");
    // Visible rather than hidden — "why is this not going?" is the question
    // the user actually has.
    expect(rows).toHaveLength(2);
  });

  it("refuses a rejected document", async () => {
    const fixture = setup();
    const [requirementId] = await uploadAndVerify(fixture, 1);
    if (!requirementId) throw new Error("expected a requirement");

    const rejected = rejectDocument(requirementId, "Blurry scan.", fixture.loginExecutiveId);
    expect(rejected.ok).toBe(true);

    const row = sendableDocumentsFor(fixture.caseId)[0];
    expect(row?.blockedBecause).toContain("Rejected on review");
  });

  it("never lists a requirement with nothing uploaded against it", async () => {
    const fixture = setup();
    await uploadAndVerify(fixture, 1);

    const outstanding = getDb().requirements.filter(
      (r) => r.caseId === fixture.caseId && r.status === "pending",
    );
    expect(outstanding.length).toBeGreaterThan(0);
    // A missing document is not a file that could be sent.
    expect(sendableDocumentsFor(fixture.caseId)).toHaveLength(1);
  });

  it("refuses to plan when an unverified document is chosen anyway", async () => {
    const fixture = setup();
    await uploadAndVerify(fixture, 1);
    const pending = getDb().requirements.find(
      (r) => r.caseId === fixture.caseId && r.status === "pending",
    );
    if (!pending) throw new Error("expected another pending requirement");
    await uploadDocument(
      pending.id,
      { name: "unverified.pdf", size: 2048, bytes: new Uint8Array([1]) },
      fixture.telecallerId,
    );

    const all = sendableDocumentsFor(fixture.caseId).map((row) => row.documentId);
    const prepared = prepareFor(fixture, all);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.message).toContain("Not verified");
  });
});

// ---------------------------------------------------------------------------
// Composition, from real case data.
// ---------------------------------------------------------------------------

describe("what the email says, built from the case", () => {
  it("names the customer, the loan product and the banker", async () => {
    const fixture = setup();
    await uploadAndVerify(fixture, 2);
    const prepared = prepareFor(fixture, verifiedDocumentIds(fixture));
    if (!prepared.ok) throw new Error(prepared.message);

    const plan = prepared.prepared.plan;
    expect(plan.context.customerName).toBe("Ravi Kumar");
    expect(plan.context.loanTypeName).toBe("Machinery and Equipment Loan");
    expect(plan.to[0]?.email).toBe("karthik@examplebank.com");
    expect(plan.cc[0]?.email).toBe("homeloans.cbe@examplebank.com");

    const email = plan.emails[0];
    expect(email?.subject).toContain("Ravi Kumar - Machinery and Equipment Loan - ");
    expect(email?.body).toContain("Dear Karthik,");
    expect(email?.body).toContain("Regards,\nAmaze Loans");
  });

  it("sends one email when everything fits and several when it does not", async () => {
    const single = setup();
    await uploadAndVerify(single, 3, [1 * MB, 1 * MB, 1 * MB]);
    const smallPlan = prepareFor(single, verifiedDocumentIds(single));
    if (!smallPlan.ok) throw new Error(smallPlan.message);
    expect(smallPlan.prepared.plan.emails).toHaveLength(1);

    const large = setup();
    await uploadAndVerify(large, 4, [6 * MB, 6 * MB, 6 * MB, 6 * MB]);
    const bigPlan = prepareFor(large, verifiedDocumentIds(large));
    if (!bigPlan.ok) throw new Error(bigPlan.message);
    expect(bigPlan.prepared.plan.emails.length).toBeGreaterThan(1);
    for (const email of bigPlan.prepared.plan.emails) {
      expect(email.totalBytes).toBeLessThanOrEqual(10 * MB);
    }
  });
});

// ---------------------------------------------------------------------------
// Sending.
// ---------------------------------------------------------------------------

describe("sending", () => {
  it("sends every batch and records the package, the emails and the documents", async () => {
    const fixture = setup();
    await uploadAndVerify(fixture, 4, [6 * MB, 6 * MB, 6 * MB, 1 * MB]);
    const documentIds = verifiedDocumentIds(fixture);
    const provider = new RecordingProvider();

    const outcome = await sendFor(fixture, documentIds, provider);
    expect(outcome.ok).toBe(true);
    expect(outcome.failedCount).toBe(0);

    const [sent] = packagesFor(fixture.submissionId);
    if (!sent) throw new Error("expected a package");

    expect(sent.status).toBe("sent");
    expect(sent.documentCount).toBe(documentIds.length);
    // The initiating employee is recorded, and it is the sender, not the
    // case owner.
    expect(sent.initiatedBy).toBe(fixture.loginExecutiveId);
    expect(sent.provider).toBe("recording");
    expect(sent.completedAt).toBeDefined();

    const emails = packageEmailsOf(sent.id);
    expect(emails.length).toBe(sent.emailCount);
    expect(emails.length).toBeGreaterThan(1);
    for (const email of emails) {
      expect(email.status).toBe("sent");
      expect(email.sentAt).toBeDefined();
      expect(email.providerMessageId).toBeDefined();
      expect(email.attemptCount).toBe(1);
      expect(email.attachmentBytes).toBeLessThanOrEqual(10 * MB);
    }

    // Every selected document, in exactly one email.
    const carried = emails.flatMap((email) => packageDocumentsOf(email.id));
    expect(carried).toHaveLength(documentIds.length);
    expect(new Set(carried.map((row) => row.documentId)).size).toBe(documentIds.length);
    expect([...carried.map((row) => row.documentId)].sort()).toEqual([...documentIds].sort());

    // Recipients are recorded, To and Copied kept apart.
    const recipients = packageRecipientsOf(sent.id);
    expect(recipients.filter((r) => r.recipientKind === "to").map((r) => r.email)).toEqual([
      "karthik@examplebank.com",
    ]);
    expect(recipients.filter((r) => r.recipientKind === "cc").map((r) => r.email)).toEqual([
      "homeloans.cbe@examplebank.com",
    ]);
  });

  it("hands the provider real bytes, addressed and subjected", async () => {
    const fixture = setup();
    await uploadAndVerify(fixture, 2);
    const provider = new RecordingProvider();
    await sendFor(fixture, verifiedDocumentIds(fixture), provider);

    const email = provider.sent[0];
    expect(email).toBeDefined();
    expect(email?.to.map((address) => address.email)).toEqual(["karthik@examplebank.com"]);
    expect(email?.cc?.map((address) => address.email)).toEqual(["homeloans.cbe@examplebank.com"]);
    expect(email?.from.email).toBe("amazeloans@gmail.com");
    expect(email?.attachments).toHaveLength(2);
    for (const attachment of email?.attachments ?? []) {
      expect(attachment.bytes.byteLength).toBeGreaterThan(0);
      expect(attachment.contentType).toBe("application/pdf");
    }
  });

  it("writes 'Documents sent to banker' to the case timeline, and one event per email", async () => {
    const fixture = setup();
    await uploadAndVerify(fixture, 2);
    const provider = new RecordingProvider();
    await sendFor(fixture, verifiedDocumentIds(fixture), provider);

    const events = getDb().events.filter((event) => event.caseId === fixture.caseId);

    const submissionEvent = events.find((event) => event.eventType === "submission.documents_sent");
    expect(submissionEvent).toBeDefined();
    expect(submissionEvent?.summary).toContain("Documents sent to banker");
    expect(submissionEvent?.summary).toContain("karthik@examplebank.com");
    expect(submissionEvent?.actorUserId).toBe(fixture.loginExecutiveId);

    const emailEvents = events.filter((event) => event.eventType === "submission.email_sent");
    expect(emailEvents).toHaveLength(1);
    // The subject is in the audit trail, as the milestone asks.
    expect(emailEvents[0]?.summary).toContain("Ravi Kumar - Machinery and Equipment Loan");
  });

  it("refuses an invalid recipient before anything is sent", async () => {
    const fixture = setup();
    await uploadAndVerify(fixture, 1);
    const provider = new RecordingProvider();

    const prepared = prepareDocumentPackage(
      {
        submissionId: fixture.submissionId,
        documentIds: verifiedDocumentIds(fixture),
        recipients: [{ email: "karthik", kind: "to" }],
      },
      fixture.loginExecutiveId,
    );
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.message).toContain("does not look like an email address");

    const outcome = await sendDocumentPackage(
      {
        submissionId: fixture.submissionId,
        documentIds: verifiedDocumentIds(fixture),
        recipients: [{ email: "karthik", kind: "to" }],
        fingerprint: "whatever",
      },
      fixture.loginExecutiveId,
      provider,
    );
    expect(outcome.ok).toBe(false);
    expect(provider.attempts).toHaveLength(0);
    expect(packagesFor(fixture.submissionId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Document integrity.
// ---------------------------------------------------------------------------

describe("document integrity", () => {
  it("sends the current verified version after a replacement, never the superseded one", async () => {
    const fixture = setup();
    const [requirementId] = await uploadAndVerify(fixture, 1);
    if (!requirementId) throw new Error("expected a requirement");

    const first = getDb().documents.find(
      (document) => document.fileName === "document-1.pdf",
    );
    expect(first?.version).toBe(1);

    // Replace it, and verify the replacement.
    const replaced = await uploadDocument(
      requirementId,
      { name: "document-1-v2.pdf", size: 4096, bytes: new Uint8Array([2]) },
      fixture.telecallerId,
    );
    expect(replaced.ok).toBe(true);
    verifyDocument(requirementId, fixture.loginExecutiveId);

    const rows = sendableDocumentsFor(fixture.caseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fileName).toBe("document-1-v2.pdf");
    expect(rows[0]?.version).toBe(2);

    const provider = new RecordingProvider();
    await sendFor(fixture, verifiedDocumentIds(fixture), provider);

    const [sent] = packagesFor(fixture.submissionId);
    const carried = packageDocumentsOf(packageEmailsOf(sent!.id)[0]!.id);
    expect(carried[0]?.documentVersion).toBe(2);
    expect(carried[0]?.fileName).toBe("document-1-v2.pdf");
    // The old row is still there, untouched (BR-031) — and was not sent.
    expect(getDb().documents.filter((d) => d.fileName === "document-1.pdf")).toHaveLength(1);
    expect(provider.sent[0]?.attachments.map((a) => a.fileName)).toEqual(["document-1-v2.pdf"]);
  });

  it("refuses to send when a document was replaced between review and confirmation", async () => {
    const fixture = setup();
    const [requirementId] = await uploadAndVerify(fixture, 2);
    if (!requirementId) throw new Error("expected a requirement");

    const prepared = prepareFor(fixture, verifiedDocumentIds(fixture));
    if (!prepared.ok) throw new Error(prepared.message);

    // Somebody replaces a document while the review dialog is open.
    await uploadDocument(
      requirementId,
      { name: "swapped.pdf", size: 4096, bytes: new Uint8Array([3]) },
      fixture.telecallerId,
    );
    verifyDocument(requirementId, fixture.loginExecutiveId);

    const provider = new RecordingProvider();
    const outcome = await sendDocumentPackage(
      {
        submissionId: fixture.submissionId,
        documentIds: verifiedDocumentIds(fixture),
        recipients: [{ email: "karthik@examplebank.com", name: "Karthik V", kind: "to" }],
        fingerprint: prepared.prepared.fingerprint,
      },
      fixture.loginExecutiveId,
      provider,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("changed while you were reviewing");
    expect(provider.attempts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Failure and retry.
// ---------------------------------------------------------------------------

describe("partial failure and retry", () => {
  async function threeBatchFixture(): Promise<{ fixture: Fixture; documentIds: string[] }> {
    const fixture = setup();
    await uploadAndVerify(fixture, 5, [6 * MB, 6 * MB, 6 * MB, 6 * MB, 6 * MB]);
    return { fixture, documentIds: verifiedDocumentIds(fixture) };
  }

  it("records a provider failure with the provider's own words", async () => {
    const fixture = setup();
    await uploadAndVerify(fixture, 1);
    const provider = new RecordingProvider();
    provider.failSequence(1, "authentication");

    const outcome = await sendFor(fixture, verifiedDocumentIds(fixture), provider);
    expect(outcome.ok).toBe(false);

    const [sent] = packagesFor(fixture.submissionId);
    expect(sent?.status).toBe("failed");

    const [email] = packageEmailsOf(sent!.id);
    expect(email?.status).toBe("failed");
    expect(email?.failureKind).toBe("authentication");
    expect(email?.failureMessage).toContain("mailbox connection was rejected");
    expect(email?.attemptCount).toBe(1);
    expect(email?.sentAt).toBeUndefined();
  });

  it("does not report a partial failure as success", async () => {
    const { fixture, documentIds } = await threeBatchFixture();
    const provider = new RecordingProvider();
    provider.failSequence(2);

    const outcome = await sendFor(fixture, documentIds, provider);
    expect(outcome.ok).toBe(false);
    expect(outcome.failedCount).toBe(1);
    expect(outcome.message).toMatch(/of \d+ emails? sent/);

    const [sent] = packagesFor(fixture.submissionId);
    expect(sent?.status).toBe("partially_sent");

    const events = getDb().events.filter((event) => event.caseId === fixture.caseId);
    expect(
      events.some((event) => event.eventType === "submission.documents_partially_sent"),
    ).toBe(true);
    expect(events.some((event) => event.eventType === "submission.documents_sent")).toBe(false);
    expect(events.some((event) => event.eventType === "submission.email_failed")).toBe(true);
  });

  it("carries on with the remaining emails after one fails", async () => {
    const { fixture, documentIds } = await threeBatchFixture();
    const provider = new RecordingProvider();
    provider.failSequence(1);

    await sendFor(fixture, documentIds, provider);

    const [sent] = packagesFor(fixture.submissionId);
    const emails = packageEmailsOf(sent!.id);
    expect(emails.filter((email) => email.status === "sent").length).toBe(emails.length - 1);
    // Nothing is left dangling in `pending` — every email was attempted.
    expect(emails.some((email) => email.status === "pending")).toBe(false);
  });

  it("retries only the failed email, and never resends a successful one", async () => {
    const { fixture, documentIds } = await threeBatchFixture();
    const provider = new RecordingProvider();
    provider.failSequence(2);

    await sendFor(fixture, documentIds, provider);
    const [sent] = packagesFor(fixture.submissionId);
    const firstPassSubjects = provider.sent.map((email) => email.subject);
    const attemptsBefore = provider.attempts.length;

    provider.heal();
    const retry = await retryDocumentPackage(sent!.id, fixture.loginExecutiveId, provider);

    expect(retry.ok).toBe(true);
    // Exactly one further attempt: the email that failed.
    expect(provider.attempts.length).toBe(attemptsBefore + 1);
    expect(provider.attempts[attemptsBefore]?.subject).toContain("(2/");

    // The successful ones were not sent a second time.
    const resent = provider.sent
      .map((email) => email.subject)
      .filter((subject) => firstPassSubjects.includes(subject));
    expect(resent).toHaveLength(firstPassSubjects.length);

    const emails = packageEmailsOf(sent!.id);
    expect(emails.every((email) => email.status === "sent")).toBe(true);
    expect(packagesFor(fixture.submissionId)[0]?.status).toBe("sent");

    // The retry is visible AS a retry.
    const retried = emails.find((email) => email.sequence === 2);
    expect(retried?.attemptCount).toBe(2);
    expect(retried?.failureKind).toBeUndefined();
    expect(emails.find((email) => email.sequence === 1)?.attemptCount).toBe(1);
  });

  it("says there is nothing to retry rather than sending everything again", async () => {
    const fixture = setup();
    await uploadAndVerify(fixture, 2);
    const provider = new RecordingProvider();
    await sendFor(fixture, verifiedDocumentIds(fixture), provider);

    const [sent] = packagesFor(fixture.submissionId);
    const before = provider.attempts.length;

    const retry = await retryDocumentPackage(sent!.id, fixture.loginExecutiveId, provider);
    expect(retry.ok).toBe(true);
    expect(retry.message).toContain("Nothing to retry");
    expect(provider.attempts.length).toBe(before);
  });

  it("records a storage failure as a failure of that email, not of the provider", async () => {
    const fixture = setup();
    await uploadAndVerify(fixture, 1);

    // The document row survives but its bytes do not — the object is gone
    // from storage. The email must fail, and must not be blamed on Gmail.
    const document = getDb().documents.find((d) => d.fileName === "document-1.pdf");
    if (!document) throw new Error("expected a document");
    document.filePath = "person/nobody/missing/v1-gone.pdf";

    const provider = new RecordingProvider();
    const outcome = await sendFor(fixture, verifiedDocumentIds(fixture), provider);

    expect(outcome.ok).toBe(false);
    expect(provider.attempts).toHaveLength(0);
    const [sent] = packagesFor(fixture.submissionId);
    const [email] = packageEmailsOf(sent!.id);
    expect(email?.status).toBe("failed");
    expect(email?.failureMessage).toContain("Could not read the documents from storage");
  });
});

// ---------------------------------------------------------------------------
// Permissions.
// ---------------------------------------------------------------------------

describe("permissions", () => {
  it("lets the Login Desk send", async () => {
    const fixture = setup();
    await uploadAndVerify(fixture, 1);
    const outcome = await sendFor(fixture, verifiedDocumentIds(fixture), new RecordingProvider());
    expect(outcome.ok).toBe(true);
  });

  it("refuses a Telecaller, who may upload a document but may not submit one", async () => {
    const fixture = setup();
    await uploadAndVerify(fixture, 1);
    const documentIds = verifiedDocumentIds(fixture);
    const provider = new RecordingProvider();

    // Not merely a hidden button: the store boundary refuses.
    const prepared = prepareFor(fixture, documentIds, fixture.telecallerId);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.message).toContain("submission.create");

    const outcome = await sendDocumentPackage(
      {
        submissionId: fixture.submissionId,
        documentIds,
        recipients: [{ email: "karthik@examplebank.com", kind: "to" }],
        fingerprint: "anything",
      },
      fixture.telecallerId,
      provider,
    );
    expect(outcome.ok).toBe(false);
    expect(provider.attempts).toHaveLength(0);
    expect(packagesFor(fixture.submissionId)).toHaveLength(0);
  });

  it("refuses Finance, who may read a case's submissions but not send its documents", async () => {
    // The other half of the permission question: `submission.read` alone is
    // not authority to put a customer's documents in an outgoing email.
    const fixture = setup();
    await uploadAndVerify(fixture, 1);
    const financeId = userWithRole("finance");

    const prepared = prepareFor(fixture, verifiedDocumentIds(fixture), financeId);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.message).toMatch(/submission\.create|document\.read/);
  });

  it("refuses a retry from somebody who could not have sent it", async () => {
    const fixture = setup();
    await uploadAndVerify(fixture, 1);
    const provider = new RecordingProvider();
    provider.failSequence(1);
    await sendFor(fixture, verifiedDocumentIds(fixture), provider);

    const [sent] = packagesFor(fixture.submissionId);
    provider.heal();
    const retry = await retryDocumentPackage(sent!.id, fixture.telecallerId, provider);

    expect(retry.ok).toBe(false);
    expect(retry.message).toContain("submission.create");
    expect(packageEmailsOf(sent!.id)[0]?.status).toBe("failed");
  });
});
