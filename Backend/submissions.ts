/**
 * Bank submissions and sending their documents to a banker — server-side.
 *
 * Stage 3D. Everything this file needs already existed and was unused:
 * the schema (Database/migrations/0006, 0024, 0030), the pure planning
 * logic (`@domain/submissions`), and the transition rule that only lets a
 * case become `submitted` as a system consequence
 * (`@domain/case/transitions.js`, guard `hasLiveSubmission`). This file is
 * what wires them to Postgres and to the mail backend — the same role
 * `documents.ts` plays for uploads and verification.
 *
 * THE SHAPE, mirroring `Frontend/src/fake/store.ts`'s prototype exactly:
 *
 *   createSubmission     — a bank/branch is chosen, recipients are named.
 *                          Nothing is sent. Status stays `not_submitted`.
 *   sendableDocuments    — verified documents on this case, with a reason
 *                          attached to any that cannot be sent.
 *   preparePackage       — pure: plans the email split, subjects and
 *                          bodies. Writes nothing, so a review screen can
 *                          be rebuilt on every keystroke.
 *   sendPackage          — writes the whole record FIRST (package,
 *                          recipients, emails, documents, all `pending`),
 *                          THEN sends one email at a time, committing the
 *                          result of each before moving to the next. Only
 *                          once every email in the package is `sent` does
 *                          the submission itself become `submitted` and,
 *                          through the existing transition machine, the
 *                          case with it.
 *   retryPackage         — resends only the emails still `failed`. A
 *                          package with nothing failed is a no-op: the
 *                          provider is never called for an email that
 *                          already succeeded.
 *
 * WHAT RUNS IN ONE TRANSACTION AND WHY THAT IS AN ACCEPTED TRADEOFF. Every
 * write below runs inside the one transaction the caller already opened
 * (`withActor`, `Backend/db.ts`) — the same convention every other route in
 * this codebase follows, and `documents.ts`'s `uploadDocument` already
 * accepts the identical shape of risk: an external side effect
 * (`storageAdapter.put` there, `provider.send` here) happens before commit.
 * A crash between one Gmail send succeeding and the transaction committing
 * would lose that email's row — a narrow risk (the process does not crash on
 * an ordinary provider failure or timeout, which are caught and recorded,
 * not thrown), and not the failure mode "retryable" exists for. Splitting
 * this into several transactions to close that gap would be a second,
 * one-off pattern in a codebase that otherwise has none.
 */

import {
  describePackageProblem,
  describeProblem,
  groupsIn,
  ineligibility,
  planSubmissionPackage,
  validateRecipients,
  type CandidateDocument,
  type PackagePlanInput,
  type RecipientDraft,
  type SubmissionContext,
  type SubmissionPackagePlan,
} from "@domain/submissions/index.js";
import { documentRowLabel, financialYearOf, type PeriodKind } from "@domain/requirements/index.js";
import {
  composeBody,
  type BankerRecipient,
  type EmailSender,
} from "@domain/submissions/compose.js";
import {
  describeEmailFailure,
  type EmailAttachment,
  type EmailProvider,
  type OutgoingEmail,
} from "@domain/communications/index.js";
import { evaluateTransition, type CaseSnapshot } from "@domain/case/transitions.js";
import type { CaseStage } from "@domain/case/stages.js";

import type { Queryable } from "./db.js";
import { canActOnCase, type Actor } from "./authorize.js";
import { ApiError, refusalMessage } from "./http.js";
import { recordSubmissionEvent, recordSystemCaseEvent } from "./events.js";
import { storageAdapter } from "./storage-client.js";
import { emailProvider as defaultEmailProvider } from "./mail-client.js";

const DEFAULT_SENDER: EmailSender = {
  name: process.env.AOS_MAIL_SENDER_NAME ?? "Amaze Loans",
  address: process.env.AOS_MAIL_SENDER_ADDRESS ?? "amazeloans@gmail.com",
};

// ---------------------------------------------------------------------------
// Case / submission access — the same shape documents.ts uses.
// ---------------------------------------------------------------------------

interface CaseHeader {
  id: string;
  ownerUserId: string;
  stage: CaseStage;
  isOnHold: boolean;
}

async function loadCaseHeader(client: Queryable, caseId: string): Promise<CaseHeader> {
  const { rows } = await client.query(
    `select id, owner_user_id, stage, is_on_hold from loan_case where id = $1`,
    [caseId],
  );
  const row = rows[0];
  if (!row) throw new ApiError(404, "No such case, or you do not have access to it.");
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    stage: row.stage as CaseStage,
    isOnHold: row.is_on_hold,
  };
}

function requireCaseAccess(actor: Actor, header: CaseHeader, permission: string): void {
  if (!canActOnCase(actor, header.ownerUserId, "submission.read")) {
    throw new ApiError(404, "No such case, or you do not have access to it.");
  }
  if (permission !== "submission.read" && !canActOnCase(actor, header.ownerUserId, permission)) {
    throw new ApiError(403, refusalMessage(permission));
  }
}

interface SubmissionRow {
  id: string;
  case_id: string;
  branch_organisation_id: string;
  submission_mode_id: string | null;
  status: string;
  bank_name_at_submission: string | null;
  branch_name_at_submission: string | null;
  submitted_at: string | null;
  submitted_by: string | null;
  created_at: string;
}

async function loadSubmission(
  client: Queryable,
  caseId: string,
  submissionId: string,
): Promise<SubmissionRow> {
  const { rows } = await client.query<SubmissionRow>(
    `select id, case_id, branch_organisation_id, submission_mode_id, status,
            bank_name_at_submission, branch_name_at_submission,
            submitted_at::text, submitted_by, created_at::text
       from submission where id = $1 and case_id = $2`,
    [submissionId, caseId],
  );
  const row = rows[0];
  if (!row) throw new ApiError(404, "No such submission on this case.");
  return row;
}

function counterpartyOf(row: Pick<SubmissionRow, "bank_name_at_submission" | "branch_name_at_submission">): string {
  const branch = row.branch_name_at_submission;
  if (!branch) return "Unknown branch";
  const bank = row.bank_name_at_submission;
  if (!bank || branch.startsWith(bank)) return branch;
  return `${bank} — ${branch}`;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface SubmissionView {
  readonly id: string;
  readonly caseId: string;
  readonly branchOrganisationId: string;
  readonly counterparty: string;
  readonly status: string;
  readonly submittedAt: string | null;
  readonly createdAt: string;
  readonly recipients: readonly {
    readonly id: string;
    readonly email: string;
    readonly name: string | null;
    readonly designation: string | null;
    readonly kind: string;
    readonly isPrimary: boolean;
  }[];
  readonly latestPackage: {
    readonly id: string;
    readonly status: string;
    readonly documentCount: number;
    readonly emailCount: number;
    readonly initiatedAt: string;
  } | null;
}

export async function listSubmissions(
  client: Queryable,
  actor: Actor,
  caseId: string,
): Promise<SubmissionView[]> {
  const header = await loadCaseHeader(client, caseId);
  requireCaseAccess(actor, header, "submission.read");

  const { rows } = await client.query<
    SubmissionRow & {
      latest_package_id: string | null;
      latest_package_status: string | null;
      latest_package_document_count: number | null;
      latest_package_email_count: number | null;
      latest_package_initiated_at: string | null;
    }
  >(
    `select s.id, s.case_id, s.branch_organisation_id, s.submission_mode_id, s.status,
            s.bank_name_at_submission, s.branch_name_at_submission,
            s.submitted_at::text, s.submitted_by, s.created_at::text,
            p.id as latest_package_id, p.status as latest_package_status,
            p.document_count as latest_package_document_count,
            p.email_count as latest_package_email_count,
            p.initiated_at::text as latest_package_initiated_at
       from submission s
       left join lateral (
         select * from submission_package sp
          where sp.submission_id = s.id
          order by sp.initiated_at desc
          limit 1
       ) p on true
      where s.case_id = $1
      order by s.created_at desc`,
    [caseId],
  );

  const submissionIds = rows.map((row) => row.id);
  const recipients = submissionIds.length
    ? await client.query<{
        id: string;
        submission_id: string;
        email: string;
        contact_name: string | null;
        designation: string | null;
        recipient_kind: string;
        is_primary: boolean;
        display_order: number;
      }>(
        `select id, submission_id, email, contact_name, designation, recipient_kind, is_primary, display_order
           from submission_recipient
          where submission_id = any($1::uuid[])
          order by display_order`,
        [submissionIds],
      )
    : { rows: [] };

  const recipientsBySubmission = new Map<string, typeof recipients.rows>();
  for (const recipient of recipients.rows) {
    const list = recipientsBySubmission.get(recipient.submission_id) ?? [];
    list.push(recipient);
    recipientsBySubmission.set(recipient.submission_id, list);
  }

  return rows.map((row) => ({
    id: row.id,
    caseId: row.case_id,
    branchOrganisationId: row.branch_organisation_id,
    counterparty: counterpartyOf(row),
    status: row.status,
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    recipients: (recipientsBySubmission.get(row.id) ?? []).map((recipient) => ({
      id: recipient.id,
      email: recipient.email,
      name: recipient.contact_name,
      designation: recipient.designation,
      kind: recipient.recipient_kind,
      isPrimary: recipient.is_primary,
    })),
    latestPackage: row.latest_package_id
      ? {
          id: row.latest_package_id,
          status: row.latest_package_status as string,
          documentCount: row.latest_package_document_count as number,
          emailCount: row.latest_package_email_count as number,
          initiatedAt: row.latest_package_initiated_at as string,
        }
      : null,
  }));
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

function draftsFromBody(body: Record<string, unknown>): RecipientDraft[] {
  const raw = Array.isArray(body.recipients) ? body.recipients : [];
  return raw.map((entry): RecipientDraft => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return {
      email: typeof record.email === "string" ? record.email : "",
      ...(typeof record.name === "string" && record.name.trim() !== "" ? { name: record.name } : {}),
      ...(typeof record.designation === "string" && record.designation.trim() !== ""
        ? { designation: record.designation }
        : {}),
      ...(typeof record.bankContactId === "string" ? { bankContactId: record.bankContactId } : {}),
      kind: record.kind === "cc" ? "cc" : "to",
      isPrimary: record.isPrimary === true,
    };
  });
}

export async function createSubmission(
  client: Queryable,
  actor: Actor,
  caseId: string,
  body: Record<string, unknown>,
): Promise<SubmissionView> {
  const header = await loadCaseHeader(client, caseId);
  requireCaseAccess(actor, header, "submission.create");

  const branchOrganisationId =
    typeof body.branchOrganisationId === "string" ? body.branchOrganisationId : null;
  if (!branchOrganisationId) throw new ApiError(400, "A branch is required.");

  const validated = validateRecipients(draftsFromBody(body));
  if (!validated.ok) throw new ApiError(400, describeProblem(validated.problem));

  const { rows: branchRows } = await client.query<{
    id: string;
    canonical_name: string;
    parent_organisation_id: string | null;
    institution_name: string | null;
    address_line: string | null;
    city_name: string | null;
    org_city: string | null;
  }>(
    `select b.id, b.canonical_name, b.parent_organisation_id, i.canonical_name as institution_name,
            bb.address_line, c.name as city_name, b.city as org_city
       from organisation b
       left join organisation i on i.id = b.parent_organisation_id
       left join bank_branch bb on bb.organisation_id = b.id
       left join city c on c.id = bb.city_id
      where b.id = $1 and 'branch' = any(b.roles) and b.is_active`,
    [branchOrganisationId],
  );
  const branch = branchRows[0];
  if (!branch) throw new ApiError(400, "No such branch, or it is no longer active.");

  const submissionModeId =
    typeof body.submissionModeId === "string" && body.submissionModeId !== ""
      ? body.submissionModeId
      : null;

  const inserted = await client.query<{ id: string; created_at: string }>(
    `insert into submission
       (case_id, branch_organisation_id, submission_mode_id, status,
        institution_organisation_id, bank_name_at_submission, branch_name_at_submission,
        branch_address_at_submission, branch_city_at_submission, snapshot_taken_at,
        created_by)
     values ($1, $2, $3, 'not_submitted', $4, $5, $6, $7, $8, now(), $9)
     returning id, created_at::text`,
    [
      caseId,
      branchOrganisationId,
      submissionModeId,
      branch.parent_organisation_id,
      branch.institution_name,
      branch.canonical_name,
      branch.address_line,
      branch.city_name ?? branch.org_city,
      actor.userId,
    ],
  );
  const submissionId = inserted.rows[0]!.id;

  for (const recipient of validated.recipients) {
    await client.query(
      `insert into submission_recipient
         (submission_id, bank_contact_id, email, contact_name, designation,
          is_primary, recipient_kind, display_order, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        submissionId,
        recipient.bankContactId ?? null,
        recipient.email,
        recipient.name ?? null,
        recipient.designation ?? null,
        recipient.isPrimary,
        recipient.kind,
        recipient.displayOrder,
        actor.userId,
      ],
    );
  }

  await recordSubmissionEvent(client, {
    actorUserId: actor.userId,
    caseId,
    entityType: "submission",
    entityId: submissionId,
    eventType: "submission.created",
    payloadAfter: { branchOrganisationId, recipientCount: validated.recipients.length },
  });

  const created = (await listSubmissions(client, actor, caseId)).find((s) => s.id === submissionId);
  if (!created) throw new ApiError(500, "The submission was created but could not be read back.");
  return created;
}

// ---------------------------------------------------------------------------
// Sendable documents
// ---------------------------------------------------------------------------

export interface SendableDocumentView {
  readonly requirementId: string;
  readonly documentId: string;
  readonly label: string;
  readonly documentTypeCode: string;
  readonly category: string;
  readonly fileName: string;
  readonly fileSizeBytes: number;
  readonly financialYearLabel?: string;
  readonly version: number;
  readonly blockedBecause?: string;
}

interface RequirementDocumentRow {
  requirement_id: string;
  document_id: string;
  document_type_code: string;
  category: string | null;
  type_name: string;
  period_kind: string | null;
  period_start: string | null;
  file_name: string;
  file_size_bytes: string;
  version: number;
}

async function verifiedDocumentRows(client: Queryable, caseId: string): Promise<RequirementDocumentRow[]> {
  const { rows } = await client.query<RequirementDocumentRow>(
    `select r.id as requirement_id, d.id as document_id, dt.code as document_type_code,
            dt.category, dt.name as type_name, dt.period_kind::text as period_kind,
            r.period_start::text, d.file_name, d.file_size_bytes::text, d.version
       from document_requirement r
       join document_type dt on dt.id = r.document_type_id
       join document d on d.id = r.satisfied_by_document_id
      where r.case_id = $1 and r.status = 'verified'
      order by dt.display_order, dt.code`,
    [caseId],
  );
  return rows;
}

function toCandidate(row: RequirementDocumentRow): CandidateDocument {
  const financialYearLabel = row.period_start
    ? financialYearOf(new Date(row.period_start)).label
    : undefined;
  const label = documentRowLabel(
    row.type_name,
    financialYearLabel,
    (row.period_kind ?? undefined) as PeriodKind | undefined,
  );
  return {
    documentId: row.document_id,
    requirementId: row.requirement_id,
    documentTypeCode: row.document_type_code,
    label,
    fileName: row.file_name,
    fileSizeBytes: Number(row.file_size_bytes),
    category: row.category ?? "additional",
    ...(financialYearLabel ? { financialYearLabel } : {}),
    version: row.version,
    verifiedAt: new Date().toISOString(),
  };
}

export async function sendableDocuments(
  client: Queryable,
  actor: Actor,
  caseId: string,
  submissionId: string,
): Promise<SendableDocumentView[]> {
  const header = await loadCaseHeader(client, caseId);
  requireCaseAccess(actor, header, "submission.create");
  await loadSubmission(client, caseId, submissionId);

  const rows = await verifiedDocumentRows(client, caseId);
  return rows.map((row) => {
    const candidate = toCandidate(row);
    const reason = ineligibility(candidate);
    return {
      requirementId: candidate.requirementId as string,
      documentId: candidate.documentId,
      label: candidate.label,
      documentTypeCode: candidate.documentTypeCode,
      category: candidate.category,
      fileName: candidate.fileName,
      fileSizeBytes: candidate.fileSizeBytes,
      ...(candidate.financialYearLabel ? { financialYearLabel: candidate.financialYearLabel } : {}),
      version: candidate.version,
      ...(reason ? { blockedBecause: describePackageProblem({ kind: "document_not_sendable", document: candidate, reason }) } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// The case context an email is written from
// ---------------------------------------------------------------------------

async function contextFor(
  client: Queryable,
  caseId: string,
  submission: SubmissionRow,
): Promise<SubmissionContext> {
  const { rows } = await client.query<{
    case_number: string;
    loan_product_name: string | null;
    loan_product_variant: string | null;
    applicant_name: string | null;
    applicant_org_name: string | null;
  }>(
    `select c.case_number, lp.name as loan_product_name, lp.variant as loan_product_variant,
            p.full_name as applicant_name, o.canonical_name as applicant_org_name
       from loan_case c
       left join loan_product lp on lp.id = c.loan_product_id
       left join case_party party
              on party.case_id = c.id and party.is_primary and party.removed_at is null
       left join person p on p.id = party.person_id
       left join organisation o on o.id = party.organisation_id
      where c.id = $1`,
    [caseId],
  );
  const row = rows[0];
  return {
    customerName: row?.applicant_name ?? row?.applicant_org_name ?? "The applicant",
    loanTypeName: row?.loan_product_name ?? row?.loan_product_variant ?? "Loan",
    counterparty: counterpartyOf(submission),
    ...(row?.case_number ? { caseNumber: row.case_number } : {}),
  };
}

async function recipientsFor(
  client: Queryable,
  submissionId: string,
): Promise<{ to: BankerRecipient[]; cc: BankerRecipient[]; drafts: RecipientDraft[] }> {
  const { rows } = await client.query<{
    email: string;
    contact_name: string | null;
    recipient_kind: string;
    is_primary: boolean;
    bank_contact_id: string | null;
    display_order: number;
  }>(
    `select email, contact_name, recipient_kind, is_primary, bank_contact_id, display_order
       from submission_recipient where submission_id = $1 order by display_order`,
    [submissionId],
  );
  const to: BankerRecipient[] = [];
  const cc: BankerRecipient[] = [];
  const drafts: RecipientDraft[] = [];
  for (const row of rows) {
    const address: BankerRecipient = {
      email: row.email,
      ...(row.contact_name ? { name: row.contact_name } : {}),
    };
    (row.recipient_kind === "cc" ? cc : to).push(address);
    drafts.push({
      email: row.email,
      ...(row.contact_name ? { name: row.contact_name } : {}),
      ...(row.bank_contact_id ? { bankContactId: row.bank_contact_id } : {}),
      kind: row.recipient_kind === "cc" ? "cc" : "to",
      isPrimary: row.is_primary,
    });
  }
  return { to, cc, drafts };
}

/** The document ids the caller may choose from, filtered to the ones the
 * request actually selected — the same fingerprint discipline the fake
 * store uses in `prepareDocumentPackage`. */
async function selectedCandidates(
  client: Queryable,
  caseId: string,
  documentIds: readonly string[],
): Promise<CandidateDocument[]> {
  const rows = await verifiedDocumentRows(client, caseId);
  const chosen = new Set(documentIds);
  const candidates = rows.filter((row) => chosen.has(row.document_id)).map(toCandidate);
  if (candidates.length !== chosen.size) {
    throw new ApiError(
      409,
      "One of the chosen documents is no longer verified on this case. Reopen the dialog and choose again.",
    );
  }
  return candidates;
}

function fingerprintOf(documents: readonly CandidateDocument[]): string {
  return [...documents]
    .map((document) => `${document.documentId}@${document.version}`)
    .sort()
    .join(",");
}

// ---------------------------------------------------------------------------
// Concurrency — one submission, one sender at a time (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Serialise `sendPackage`/`retryPackage` on this submission at the database
 * level, so two nearly-simultaneous requests — two employees with the same
 * case open, or one employee double-clicking Send before the first request
 * has returned — cannot both pass the eligibility checks before either has
 * made its outcome visible to the other.
 *
 * `pg_advisory_xact_lock` rather than a JavaScript mutex: this process is not
 * the only one that will ever open this submission (the whole point is the
 * future two-PC office), so only a lock PostgreSQL itself arbitrates protects
 * anything. Transaction-scoped (`_xact_`), not session-scoped: it releases
 * itself on commit or rollback with the transaction `withActor` already
 * manages, with nothing left to leak if a request throws. Keyed on the
 * submission id via `hashtextextended` (a `bigint`, the single-key overload's
 * argument type) rather than the case id: two banks on the same case are
 * independent sends and must not queue behind each other.
 */
async function lockSubmissionForSending(client: Queryable, submissionId: string): Promise<void> {
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [submissionId]);
}

/**
 * The most recently fully-sent package on this submission whose exact
 * document set (id and version, the same fingerprint `fingerprintOf` builds
 * for the client-supplied one) matches `fingerprint` — or null if none does.
 *
 * This is what turns the lock above into a genuine duplicate-send guard
 * rather than a mere queue. Read AFTER the lock is held, so it reflects
 * whatever the previous holder committed, not stale state read before
 * blocking (a second caller must decide from the first caller's outcome, not
 * from what was true when it started). A match means the identical batch of
 * documents already went out under this submission — the caller gets that
 * package's result back, unsent a second time; no new package, no repeated
 * `provider.send`. A different fingerprint (a document was added, replaced,
 * or dropped since) is a genuinely new batch and is not blocked by this
 * check — resending the same bank with an updated document set is legitimate
 * (`finalizeIfFullySent`'s "a second send is a new package").
 */
async function alreadySentPackageId(
  client: Queryable,
  submissionId: string,
  fingerprint: string,
): Promise<string | null> {
  const { rows: packageRows } = await client.query<{ id: string }>(
    `select id from submission_package
      where submission_id = $1 and status = 'sent'
      order by initiated_at desc`,
    [submissionId],
  );
  for (const { id } of packageRows) {
    const { rows: docRows } = await client.query<{ document_id: string; document_version: number }>(
      `select document_id, document_version from submission_package_document where submission_package_id = $1`,
      [id],
    );
    const sentFingerprint = docRows
      .map((row) => `${row.document_id}@${row.document_version}`)
      .sort()
      .join(",");
    if (sentFingerprint === fingerprint) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Preparing — pure, writes nothing
// ---------------------------------------------------------------------------

export interface PreparedPackageView {
  readonly plan: SubmissionPackagePlan;
  readonly fingerprint: string;
}

function documentIdsFromBody(body: Record<string, unknown>): string[] {
  return Array.isArray(body.documentIds) ? body.documentIds.filter((id): id is string => typeof id === "string") : [];
}

export async function preparePackage(
  client: Queryable,
  actor: Actor,
  caseId: string,
  submissionId: string,
  body: Record<string, unknown>,
): Promise<PreparedPackageView> {
  const header = await loadCaseHeader(client, caseId);
  requireCaseAccess(actor, header, "submission.create");
  const submission = await loadSubmission(client, caseId, submissionId);

  const documentIds = documentIdsFromBody(body);
  const candidates = await selectedCandidates(client, caseId, documentIds);
  const { drafts } = await recipientsFor(client, submissionId);

  const input: PackagePlanInput = {
    context: await contextFor(client, caseId, submission),
    recipients: drafts,
    documents: candidates,
    sender: DEFAULT_SENDER,
  };
  const planned = planSubmissionPackage(input);
  if (!planned.ok) throw new ApiError(400, describePackageProblem(planned.problem));

  return { plan: planned.plan, fingerprint: fingerprintOf(candidates) };
}

// ---------------------------------------------------------------------------
// Sending — writes the record, then sends
// ---------------------------------------------------------------------------

export interface SendResultView {
  readonly submissionPackageId: string;
  readonly sentCount: number;
  readonly failedCount: number;
  readonly message: string;
}

function contentTypeFor(fileName: string): string {
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  const known: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    heic: "image/heic",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    txt: "text/plain",
    zip: "application/zip",
  };
  return known[extension] ?? "application/octet-stream";
}

export async function sendPackage(
  client: Queryable,
  actor: Actor,
  caseId: string,
  submissionId: string,
  body: Record<string, unknown>,
  provider: EmailProvider = defaultEmailProvider,
): Promise<SendResultView> {
  const header = await loadCaseHeader(client, caseId);
  requireCaseAccess(actor, header, "submission.create");
  const submission = await loadSubmission(client, caseId, submissionId);

  // From here on this submission has exactly one sender at a time (Phase 3):
  // a concurrent call blocks here until the holder's transaction commits or
  // rolls back, then proceeds against what that call actually left behind.
  await lockSubmissionForSending(client, submissionId);

  const documentIds = documentIdsFromBody(body);
  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint : "";

  const candidates = await selectedCandidates(client, caseId, documentIds);
  if (fingerprintOf(candidates) !== fingerprint) {
    throw new ApiError(
      409,
      "These documents changed while you were reviewing them — one has been replaced or removed. " +
        "Nothing was sent. Close this and review the new list before sending.",
    );
  }

  // Re-read authoritative state now the lock is held: this exact document
  // set may already have gone out — sent by the request this one raced
  // against, or by an earlier attempt this same caller is retrying blind to.
  // Either way, the bank does not need it twice.
  const alreadySent = await alreadySentPackageId(client, submissionId, fingerprint);
  if (alreadySent) return await summariseSend(client, alreadySent);

  const { to, cc, drafts } = await recipientsFor(client, submissionId);
  const context = await contextFor(client, caseId, submission);
  const planned = planSubmissionPackage({
    context,
    recipients: drafts,
    documents: candidates,
    sender: DEFAULT_SENDER,
  });
  if (!planned.ok) throw new ApiError(400, describePackageProblem(planned.problem));
  const plan = planned.plan;

  const packageInsert = await client.query<{ id: string }>(
    `insert into submission_package
       (submission_id, initiated_by, sender_address, sender_name, provider, status,
        document_count, email_count, total_bytes)
     values ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)
     returning id`,
    [
      submissionId,
      actor.userId,
      plan.sender.address,
      plan.sender.name,
      provider.name,
      plan.documentCount,
      plan.emails.length,
      plan.totalBytes,
    ],
  );
  const packageId = packageInsert.rows[0]!.id;

  let order = 0;
  for (const recipient of [...plan.to.map((r) => ({ ...r, kind: "to" as const })), ...plan.cc.map((r) => ({ ...r, kind: "cc" as const }))]) {
    order += 10;
    await client.query(
      `insert into submission_package_recipient
         (submission_package_id, email, contact_name, recipient_kind, display_order)
       values ($1, $2, $3, $4, $5)`,
      [packageId, recipient.email, recipient.name ?? null, recipient.kind, order],
    );
  }

  const emailIds: string[] = [];
  for (const email of plan.emails) {
    const emailInsert = await client.query<{ id: string }>(
      `insert into submission_package_email
         (submission_package_id, sequence, subject, status, attachment_count, attachment_bytes, attempt_count)
       values ($1, $2, $3, 'pending', $4, $5, 0)
       returning id`,
      [packageId, email.sequence, email.subject, email.documents.length, email.totalBytes],
    );
    const emailId = emailInsert.rows[0]!.id;
    emailIds.push(emailId);

    let docOrder = 0;
    for (const document of email.documents) {
      docOrder += 10;
      await client.query(
        `insert into submission_package_document
           (submission_package_id, submission_package_email_id, document_id, document_version,
            file_name, file_size_bytes, financial_year_label, display_order)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          packageId,
          emailId,
          document.documentId,
          document.version,
          document.fileName,
          document.fileSizeBytes,
          document.financialYearLabel ?? null,
          docOrder,
        ],
      );
    }
  }

  await dispatchEmails(client, actor, caseId, submission, packageId, emailIds, { to, cc }, provider);
  await finalizeIfFullySent(client, actor, caseId, submissionId, packageId);

  return await summariseSend(client, packageId);
}

export async function retryPackage(
  client: Queryable,
  actor: Actor,
  caseId: string,
  submissionId: string,
  packageId: string,
  provider: EmailProvider = defaultEmailProvider,
): Promise<SendResultView> {
  const header = await loadCaseHeader(client, caseId);
  requireCaseAccess(actor, header, "submission.create");
  const submission = await loadSubmission(client, caseId, submissionId);

  // Same lock as `sendPackage`, same submission id: a retry and a fresh send
  // (or two concurrent retries) on the same submission must not race each
  // other over which failed emails get dispatched.
  await lockSubmissionForSending(client, submissionId);

  const { rows: packageRows } = await client.query<{ id: string }>(
    `select id from submission_package where id = $1 and submission_id = $2`,
    [packageId, submissionId],
  );
  if (!packageRows[0]) throw new ApiError(404, "No such submission package.");

  const { rows: failedRows } = await client.query<{ id: string }>(
    `select id from submission_package_email
      where submission_package_id = $1 and status = 'failed'
      order by sequence`,
    [packageId],
  );

  if (failedRows.length === 0) {
    return {
      submissionPackageId: packageId,
      sentCount: 0,
      failedCount: 0,
      message: "Nothing to retry — every email in this submission was sent.",
    };
  }

  const { rows: recipientRows } = await client.query<{ email: string; contact_name: string | null; recipient_kind: string }>(
    `select email, contact_name, recipient_kind from submission_package_recipient
      where submission_package_id = $1 order by display_order`,
    [packageId],
  );
  const to = recipientRows
    .filter((r) => r.recipient_kind !== "cc")
    .map((r): BankerRecipient => ({ email: r.email, ...(r.contact_name ? { name: r.contact_name } : {}) }));
  const cc = recipientRows
    .filter((r) => r.recipient_kind === "cc")
    .map((r): BankerRecipient => ({ email: r.email, ...(r.contact_name ? { name: r.contact_name } : {}) }));

  await dispatchEmails(
    client,
    actor,
    caseId,
    submission,
    packageId,
    failedRows.map((r) => r.id),
    { to, cc },
    provider,
  );
  await finalizeIfFullySent(client, actor, caseId, submissionId, packageId);

  return await summariseSend(client, packageId);
}

async function summariseSend(client: Queryable, packageId: string): Promise<SendResultView> {
  const { rows } = await client.query<{ status: string; sequence: number }>(
    `select status, sequence from submission_package_email where submission_package_id = $1`,
    [packageId],
  );
  const sentCount = rows.filter((r) => r.status === "sent").length;
  const failedCount = rows.filter((r) => r.status === "failed").length;
  return {
    submissionPackageId: packageId,
    sentCount,
    failedCount,
    message:
      failedCount === 0
        ? `${sentCount} email${sentCount === 1 ? "" : "s"} sent.`
        : `${sentCount} of ${rows.length} email${rows.length === 1 ? "" : "s"} sent. ${failedCount} failed.`,
  };
}

/**
 * Send (or resend) specific emails of a package, one at a time, and record
 * the result of each against its own row before moving to the next.
 *
 * Shared by the first send and by a retry, which is what makes a retry
 * genuinely the same operation over a smaller set rather than a second
 * code path that could drift (mirrors `dispatchEmails` in the fake store).
 */
async function dispatchEmails(
  client: Queryable,
  actor: Actor,
  caseId: string,
  submission: SubmissionRow,
  packageId: string,
  emailIds: readonly string[],
  recipients: { to: BankerRecipient[]; cc: BankerRecipient[] },
  provider: EmailProvider,
): Promise<void> {
  const { rows: packageRows } = await client.query<{ sender_address: string; sender_name: string; email_count: number }>(
    `select sender_address, sender_name, email_count from submission_package where id = $1`,
    [packageId],
  );
  const packageRow = packageRows[0];
  if (!packageRow) return;

  const context = await contextFor(client, caseId, submission);
  const greeted = recipients.to[0];

  for (const emailId of emailIds) {
    const { rows: emailRows } = await client.query<{ id: string; sequence: number; subject: string }>(
      `select id, sequence, subject from submission_package_email where id = $1`,
      [emailId],
    );
    const emailRow = emailRows[0];
    if (!emailRow) continue;

    const { rows: documentRows } = await client.query<{
      document_id: string;
      document_version: number;
      file_name: string;
      file_size_bytes: string;
      financial_year_label: string | null;
      file_path: string;
      document_type_code: string;
      category: string | null;
      type_name: string;
      period_kind: string | null;
    }>(
      `select spd.document_id, spd.document_version, spd.file_name, spd.file_size_bytes::text,
              spd.financial_year_label, d.file_path, dt.code as document_type_code, dt.category,
              dt.name as type_name, dt.period_kind::text as period_kind
         from submission_package_document spd
         join document d on d.id = spd.document_id
         join document_type dt on dt.id = d.document_type_id
        where spd.submission_package_email_id = $1
        order by spd.display_order`,
      [emailId],
    );

    const documents: CandidateDocument[] = documentRows.map((row) => ({
      documentId: row.document_id,
      documentTypeCode: row.document_type_code,
      label: documentRowLabel(
        row.type_name,
        row.financial_year_label ?? undefined,
        (row.period_kind ?? undefined) as PeriodKind | undefined,
      ),
      fileName: row.file_name,
      fileSizeBytes: Number(row.file_size_bytes),
      category: row.category ?? "additional",
      ...(row.financial_year_label ? { financialYearLabel: row.financial_year_label } : {}),
      version: row.document_version,
      verifiedAt: new Date().toISOString(),
    }));

    let attachments: EmailAttachment[];
    try {
      attachments = await Promise.all(
        documentRows.map(async (row): Promise<EmailAttachment> => {
          const bytes = await storageAdapter.get(row.file_path);
          return { fileName: row.file_name, contentType: contentTypeFor(row.file_name), bytes };
        }),
      );
    } catch (error) {
      await client.query(
        `update submission_package_email
            set status = 'failed', attempt_count = attempt_count + 1,
                failure_kind = 'unknown', failure_message = $2
          where id = $1`,
        [
          emailId,
          error instanceof Error
            ? `Could not read the documents from storage: ${error.message}`
            : "Could not read the documents from storage.",
        ],
      );
      await recordSubmissionEvent(client, {
        actorUserId: actor.userId,
        caseId,
        entityType: "submission_package_email",
        entityId: emailId,
        eventType: "submission.email_failed",
        payloadAfter: { sequence: emailRow.sequence },
      });
      continue;
    }

    const outgoing: OutgoingEmail = {
      submissionPackageEmailId: emailId,
      from: { email: packageRow.sender_address, name: packageRow.sender_name },
      to: recipients.to,
      ...(recipients.cc.length > 0 ? { cc: recipients.cc } : {}),
      subject: emailRow.subject,
      body: composeBody({
        context,
        recipient: greeted ?? { email: packageRow.sender_address },
        batch: {
          sequence: emailRow.sequence,
          documents,
          totalBytes: documents.reduce((total, d) => total + d.fileSizeBytes, 0),
          groups: groupsIn(documents),
        },
        batchCount: packageRow.email_count,
        sender: { name: packageRow.sender_name, address: packageRow.sender_address },
      }),
      attachments,
    };

    const result = await provider.send(outgoing);

    if (result.ok) {
      await client.query(
        `update submission_package_email
            set status = 'sent', sent_at = $2, provider_message_id = $3,
                attempt_count = attempt_count + 1, failure_kind = null, failure_message = null
          where id = $1`,
        [emailId, result.sentAt, result.providerMessageId ?? null],
      );
      await recordSubmissionEvent(client, {
        actorUserId: actor.userId,
        caseId,
        entityType: "submission_package_email",
        entityId: emailId,
        eventType: "submission.email_sent",
        payloadAfter: { sequence: emailRow.sequence, attachmentCount: documents.length },
      });
    } else {
      await client.query(
        `update submission_package_email
            set status = 'failed', attempt_count = attempt_count + 1,
                failure_kind = $2, failure_message = $3
          where id = $1`,
        [emailId, result.failure.kind, describeEmailFailure(result.failure)],
      );
      await recordSubmissionEvent(client, {
        actorUserId: actor.userId,
        caseId,
        entityType: "submission_package_email",
        entityId: emailId,
        eventType: "submission.email_failed",
        payloadAfter: { sequence: emailRow.sequence, failureKind: result.failure.kind },
      });
    }
  }

  await rollUpPackageStatus(client, packageId);

  const { rows: finalRows } = await client.query<{ status: string }>(
    `select status from submission_package_email where submission_package_id = $1`,
    [packageId],
  );
  const sentCount = finalRows.filter((r) => r.status === "sent").length;
  const failedCount = finalRows.filter((r) => r.status === "failed").length;

  await recordSubmissionEvent(client, {
    actorUserId: actor.userId,
    caseId,
    entityType: "submission_package",
    entityId: packageId,
    eventType: failedCount === 0 ? "submission.documents_sent" : "submission.documents_partially_sent",
    payloadAfter: { sentCount, failedCount, total: finalRows.length },
  });
}

/** `submission_package.status`, derived from its emails and never rounded
 * up — `partially_sent` is the reason this is not a boolean (0030's own
 * comment: reporting two-of-three as "sent" would stop somebody chasing a
 * bank that never received the file). */
async function rollUpPackageStatus(client: Queryable, packageId: string): Promise<void> {
  const { rows } = await client.query<{ status: string }>(
    `select status from submission_package_email where submission_package_id = $1`,
    [packageId],
  );
  const sent = rows.filter((r) => r.status === "sent").length;
  const failed = rows.filter((r) => r.status === "failed").length;

  const status =
    sent === rows.length ? "sent" : sent === 0 && failed === rows.length ? "failed" : sent > 0 ? "partially_sent" : "pending";

  await client.query(
    `update submission_package
        set status = $2, completed_at = case when $2 in ('sent','partially_sent','failed') then now() else completed_at end
      where id = $1`,
    [packageId, status],
  );
}

/**
 * After a package's emails settle, ask the existing transition machine
 * whether the case should move — never a second state machine. Fires only
 * once: the update to `submission.status` is guarded by
 * `status = 'not_submitted'`, so a second package sent to an
 * already-submitted bank (0030's "a second send is a new package") neither
 * re-dispatches the submission nor re-fires the case transition.
 */
async function finalizeIfFullySent(
  client: Queryable,
  actor: Actor,
  caseId: string,
  submissionId: string,
  packageId: string,
): Promise<void> {
  const { rows: packageRows } = await client.query<{ status: string }>(
    `select status from submission_package where id = $1`,
    [packageId],
  );
  if (packageRows[0]?.status !== "sent") return;

  const dispatched = await client.query<{ id: string }>(
    `update submission set status = 'submitted', submitted_at = now(), submitted_by = $2
      where id = $1 and status = 'not_submitted'
      returning id`,
    [submissionId, actor.userId],
  );
  if (dispatched.rows.length === 0) return; // Already dispatched by an earlier package.

  const header = await loadCaseHeader(client, caseId);
  if (header.isOnHold) return;
  if (header.stage !== "ready_for_submission") return;

  const liveSubmissionCount = await liveSubmissionCountFor(client, caseId);
  const outstandingRequirementCount = await outstandingRequirementCountFor(client, caseId);

  const snapshot: CaseSnapshot = {
    stage: header.stage,
    outstandingRequirementCount,
    liveSubmissionCount,
    hasSanctionedSubmissionWithOffer: false,
    hasDisbursedSubmission: false,
    isInvoiceRaised: false,
    stageBeforeLost: null,
  };

  const verdict = evaluateTransition(snapshot, { to: "submitted", actor: "system" });
  if (!verdict.allowed) return;

  await client.query(`update loan_case set stage = 'submitted' where id = $1`, [caseId]);
  await recordSystemCaseEvent(client, {
    caseId,
    eventType: "case.stage_changed",
    payloadBefore: { stage: "ready_for_submission" },
    payloadAfter: { stage: "submitted" },
    causedByEntityType: "submission",
    causedByEntityId: submissionId,
  });
}

async function liveSubmissionCountFor(client: Queryable, caseId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `select count(*) as n from submission where case_id = $1 and status <> 'not_submitted'`,
    [caseId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function outstandingRequirementCountFor(client: Queryable, caseId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `select count(*) as n from document_requirement
      where case_id = $1 and status in ('pending', 'received', 'rejected')`,
    [caseId],
  );
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Packages — for the status list
// ---------------------------------------------------------------------------

export interface PackageEmailView {
  readonly id: string;
  readonly sequence: number;
  readonly subject: string;
  readonly status: string;
  readonly attachmentCount: number;
  readonly attemptCount: number;
  readonly sentAt: string | null;
  readonly providerMessageId: string | null;
  readonly failureMessage: string | null;
}

export interface PackageView {
  readonly id: string;
  readonly status: string;
  readonly documentCount: number;
  readonly emailCount: number;
  readonly initiatedAt: string;
  readonly completedAt: string | null;
  readonly emails: readonly PackageEmailView[];
}

export async function listPackages(
  client: Queryable,
  actor: Actor,
  caseId: string,
  submissionId: string,
): Promise<PackageView[]> {
  const header = await loadCaseHeader(client, caseId);
  requireCaseAccess(actor, header, "submission.read");
  await loadSubmission(client, caseId, submissionId);

  const { rows: packages } = await client.query<{
    id: string;
    status: string;
    document_count: number;
    email_count: number;
    initiated_at: string;
    completed_at: string | null;
  }>(
    `select id, status, document_count, email_count, initiated_at::text, completed_at::text
       from submission_package where submission_id = $1 order by initiated_at desc`,
    [submissionId],
  );

  const packageIds = packages.map((p) => p.id);
  const emails = packageIds.length
    ? await client.query<{
        id: string;
        submission_package_id: string;
        sequence: number;
        subject: string;
        status: string;
        attachment_count: number;
        attempt_count: number;
        sent_at: string | null;
        provider_message_id: string | null;
        failure_message: string | null;
      }>(
        `select id, submission_package_id, sequence, subject, status, attachment_count, attempt_count,
                sent_at::text, provider_message_id, failure_message
           from submission_package_email
          where submission_package_id = any($1::uuid[])
          order by sequence`,
        [packageIds],
      )
    : { rows: [] };

  const emailsByPackage = new Map<string, typeof emails.rows>();
  for (const email of emails.rows) {
    const list = emailsByPackage.get(email.submission_package_id) ?? [];
    list.push(email);
    emailsByPackage.set(email.submission_package_id, list);
  }

  return packages.map((row) => ({
    id: row.id,
    status: row.status,
    documentCount: row.document_count,
    emailCount: row.email_count,
    initiatedAt: row.initiated_at,
    completedAt: row.completed_at,
    emails: (emailsByPackage.get(row.id) ?? []).map((email) => ({
      id: email.id,
      sequence: email.sequence,
      subject: email.subject,
      status: email.status,
      attachmentCount: email.attachment_count,
      attemptCount: email.attempt_count,
      sentAt: email.sent_at,
      providerMessageId: email.provider_message_id,
      failureMessage: email.failure_message,
    })),
  }));
}
