/**
 * The fake backend.
 *
 * An in-memory database with a subscribe/notify store, persisted to
 * localStorage so clicking around survives a refresh. It will be replaced by
 * Supabase; the shapes match the schema so that replacement is a substitution.
 *
 * **The business rules in here are not fake.** Stage transitions go through
 * `evaluateTransition`, auto-advance goes through `deriveSystemStagePath`,
 * progress goes through `summariseProgress`, and case numbers through
 * `formatCaseNumber` — all from src/domain/, all the same code the server will
 * run. Every write pairs with an event, because BR-050 says a state change that
 * skips its event is a bug.
 */

import { formatCaseNumber } from "@domain/case/case-number.js";
import {
  type CaseStage,
  type LostReason,
  isTerminalStage,
} from "@domain/case/stages.js";
import {
  type CaseSnapshot,
  deriveSystemStagePath,
  evaluateTransition,
} from "@domain/case/transitions.js";
import { type Requirement, summariseProgress } from "@domain/requirements/progress.js";
import { recentFinancialYears } from "@domain/requirements/financial-year.js";
import {
  buildStoragePath,
  nextVersion,
  resolveDocumentOwner,
} from "@domain/storage/index.js";

import { applyExistingDocuments, regenerateRequirements } from "./requirements.js";
import { storageAdapter } from "./storage.js";
import { buildSeed } from "./seed.js";
import type { LendingProduct } from "@domain/products/index.js";
import type {
  LenderBranch,
  LenderInsight as DomainLenderInsight,
  LenderInstitution,
  SubmissionRule as DomainSubmissionRule,
  SupportedProduct as DomainSupportedProduct,
} from "@domain/lenders/index.js";

import type {
  AosEvent,
  AvailabilityStatus,
  BankBranch,
  BankContact,
  BankProduct,
  BranchStatus,
  CasePartyRole,
  Database,
  Id,
  LenderInsight,
  LenderProfile,
  LenderSubmissionRule,
  LoanCase,
  LoanProduct,
  MasterDataRecord,
  Organisation,
  Person,
  SubmissionStatus,
} from "./types.js";

/**
 * Bumped whenever the seeded shape changes in a way a stored database cannot
 * satisfy — v2 for the Lending Product Catalogue (Milestone 7), which added
 * three master-data collections and made `isActive` a required field on a
 * product. A stale v1 store would render a catalogue of products that all
 * look retired, which is worse than starting fresh from a seed that is, by
 * the footer's own admission, fake.
 *
 * v3 for the Bank & NBFC Catalogue (Milestone 8), which adds ten collections
 * — a stale v2 store would open the Lenders screen on an empty catalogue and
 * read as a broken feature rather than as stale data.
 */
const STORAGE_KEY = "aos.prototype.v3";

let counter = 1000;
const nextId = (): string => `gen_${++counter}`;

// ---------------------------------------------------------------------------
// Store plumbing
// ---------------------------------------------------------------------------

let db: Database = load();
const listeners = new Set<() => void>();

function load(): Database {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw) as Database;
    }
  } catch {
    // A corrupt or unreadable store is not worth recovering from in a
    // prototype; falling back to the seed is always better than a blank screen.
  }
  return bootstrap();
}

function bootstrap(): Database {
  // Works on a local rather than the module-level `db`, which is still in its
  // temporal dead zone when this runs during module initialisation.
  const seeded = buildSeed();

  for (const loanCase of seeded.cases) {
    const generated = applyExistingDocuments(
      seeded,
      regenerateRequirements(seeded, loanCase.id, nextId),
    );
    seeded.requirements = [
      ...seeded.requirements.filter((r) => r.caseId !== loanCase.id),
      ...generated,
    ];
  }

  // Nudge the seeded cases into a believable state of collection: cases that
  // have already reached a bank should not look untouched.
  for (const loanCase of seeded.cases) {
    if (["submitted", "sanctioned", "disbursed", "lost"].includes(loanCase.stage)) {
      seeded.requirements = seeded.requirements.map((r) =>
        r.caseId === loanCase.id && r.status === "pending"
          ? { ...r, status: "verified" as const }
          : r,
      );
    }
  }

  // One document received but not verified, so the login desk has something to
  // do on first load.
  const arunPan = seeded.documents.find((d) => d.fileName === "arun-pan.jpg");
  if (arunPan) {
    seeded.requirements = seeded.requirements.map((r) =>
      r.caseId === "cas_002" && r.documentTypeId === arunPan.documentTypeId
        ? { ...r, status: "received" as const, satisfiedByDocumentId: arunPan.id }
        : r,
    );
  }

  return seeded;
}

function commit(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    // Over quota, or private browsing. The prototype still works in memory.
  }
  for (const listener of listeners) {
    listener();
  }
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDb(): Database {
  return db;
}

export function resetDatabase(): void {
  localStorage.removeItem(STORAGE_KEY);
  db = bootstrap();
  commit();
}

// ---------------------------------------------------------------------------
// Events — every write pairs with one (BR-050)
// ---------------------------------------------------------------------------

interface EventInput {
  actorUserId?: Id;
  caseId?: Id;
  entityType: string;
  entityId?: Id;
  eventType: string;
  summary: string;
  causedBy?: string;
}

function record(input: EventInput): void {
  const event: AosEvent = {
    id: nextId(),
    occurredAt: new Date().toISOString(),
    actorKind: input.actorUserId ? "user" : "system",
    ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
    ...(input.caseId ? { caseId: input.caseId } : {}),
    entityType: input.entityType,
    ...(input.entityId ? { entityId: input.entityId } : {}),
    eventType: input.eventType,
    summary: input.summary,
    ...(input.causedBy ? { causedBy: input.causedBy } : {}),
  };
  db.events = [...db.events, event];
}

// ---------------------------------------------------------------------------
// Derived reads
// ---------------------------------------------------------------------------

export function requirementsAsDomain(caseId: Id): Requirement[] {
  return db.requirements
    .filter((r) => r.caseId === caseId)
    .map((r) => ({
      id: r.id,
      status: r.status,
      applicableFromStage: r.applicableFromStage,
    }));
}

export function progressFor(caseId: Id): ReturnType<typeof summariseProgress> {
  const loanCase = db.cases.find((c) => c.id === caseId);
  return summariseProgress(
    requirementsAsDomain(caseId),
    loanCase?.stage ?? "new",
  );
}

/** The snapshot the domain's transition guards need. */
export function snapshotOf(loanCase: LoanCase): CaseSnapshot {
  const submissions = db.submissions.filter((s) => s.caseId === loanCase.id);
  const progress = progressFor(loanCase.id);

  const sanctionedWithOffer = submissions.some(
    (s) =>
      (s.status === "sanctioned" || s.status === "disbursed") &&
      db.offers.some((o) => o.submissionId === s.id),
  );

  return {
    stage: loanCase.stage,
    outstandingRequirementCount: progress.outstandingCount,
    liveSubmissionCount: submissions.filter((s) => s.status !== "not_submitted").length,
    hasSanctionedSubmissionWithOffer: sanctionedWithOffer,
    hasDisbursedSubmission: submissions.some((s) => s.status === "disbursed"),
    isInvoiceRaised: loanCase.isInvoiceRaised,
    stageBeforeLost: loanCase.stageBeforeLost ?? null,
  };
}

// ---------------------------------------------------------------------------
// Stage movement
// ---------------------------------------------------------------------------

function stageLabel(stage: CaseStage): string {
  return stage.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Apply every automatic advance the facts justify, one transition at a time.
 *
 * Each step is a separate event: a case that reaches `disbursed` from
 * `submitted` was sanctioned on the way, and the timeline has to say so
 * (ADR-019).
 */
function autoAdvance(caseId: Id, cause: string): void {
  const loanCase = db.cases.find((c) => c.id === caseId);
  if (!loanCase || isTerminalStage(loanCase.stage)) {
    return;
  }

  const path = deriveSystemStagePath(snapshotOf(loanCase));
  for (const stage of path) {
    const from = db.cases.find((c) => c.id === caseId)?.stage;
    db.cases = db.cases.map((c) => (c.id === caseId ? { ...c, stage } : c));
    record({
      caseId,
      entityType: "case",
      entityId: caseId,
      eventType: "case.stage_changed",
      summary: `${stageLabel(from ?? "new")} → ${stageLabel(stage)}`,
      causedBy: cause,
    });
  }
}

/**
 * Re-evaluate the documents-pending ↔ ready-for-submission pair.
 *
 * The backwards move is the one people forget and it is not an error case: a
 * co-applicant added in week three, or a bank asking for something nobody
 * anticipated. It must be automatic and visible (PRD/Workflow.md, ADR-010).
 */
function reconcileReadiness(caseId: Id, cause: string): void {
  const loanCase = db.cases.find((c) => c.id === caseId);
  if (!loanCase) {
    return;
  }

  for (const target of ["ready_for_submission", "documents_pending"] as const) {
    const current = db.cases.find((c) => c.id === caseId);
    if (!current) return;
    const outcome = evaluateTransition(snapshotOf(current), {
      to: target,
      actor: "system",
    });
    if (outcome.allowed) {
      db.cases = db.cases.map((c) => (c.id === caseId ? { ...c, stage: target } : c));
      record({
        caseId,
        entityType: "case",
        entityId: caseId,
        eventType: "case.stage_changed",
        summary: `${stageLabel(current.stage)} → ${stageLabel(target)}`,
        causedBy: cause,
      });
      return;
    }
  }
}

export interface ActionResult {
  ok: boolean;
  message?: string;
}

export function moveStage(
  caseId: Id,
  to: CaseStage,
  actorUserId: Id,
  lostReason?: LostReason,
  lostNote?: string,
): ActionResult {
  const loanCase = db.cases.find((c) => c.id === caseId);
  if (!loanCase) {
    return { ok: false, message: "Case not found." };
  }

  const outcome = evaluateTransition(snapshotOf(loanCase), {
    to,
    actor: "user",
    ...(lostReason ? { lostReason } : {}),
  });

  if (!outcome.allowed) {
    return { ok: false, message: outcome.reason };
  }

  db.cases = db.cases.map((c) => {
    if (c.id !== caseId) return c;
    if (to === "lost") {
      return {
        ...c,
        stage: to,
        stageBeforeLost: c.stage,
        ...(lostReason ? { lostReason } : {}),
        ...(lostNote ? { lostNote } : {}),
        isOnHold: false,
      };
    }
    if (to === "closed") {
      return { ...c, stage: to, closedAt: new Date().toISOString() };
    }
    return { ...c, stage: to };
  });

  record({
    actorUserId,
    caseId,
    entityType: "case",
    entityId: caseId,
    eventType: to === "lost" ? "case.marked_lost" : "case.stage_changed",
    summary:
      to === "lost"
        ? `Marked lost: ${(lostReason ?? "").replace(/_/g, " ")}`
        : `${stageLabel(loanCase.stage)} → ${stageLabel(to)}`,
  });

  commit();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export interface NewCaseInput {
  applicantPersonId?: Id;
  newApplicantName?: string;
  newApplicantPhone?: string;
  loanProductId: Id;
  requestedAmount?: number;
  /** The referral source's master-data id (Milestone 5). `source` is
   * derived from it for backward compatibility with anything still reading
   * the free-text field. */
  referralSourceId?: Id;
}

export function createCase(input: NewCaseInput, actorUserId: Id): Id {
  let personId = input.applicantPersonId;

  if (!personId) {
    personId = nextId();
    db.people = [
      ...db.people,
      {
        id: personId,
        fullName: input.newApplicantName ?? "Unnamed",
        aliases: [],
        identifiers: input.newApplicantPhone
          ? [
              {
                id: nextId(),
                type: "phone",
                value: input.newApplicantPhone,
                isPrimary: true,
                verificationSource: "self_declared",
              },
            ]
          : [],
      },
    ];
    record({
      actorUserId,
      entityType: "person",
      entityId: personId,
      eventType: "person.created",
      summary: `Person created: ${input.newApplicantName ?? "Unnamed"}`,
    });
  }

  // Allocated at creation, including for leads (ADR-024). A telecaller on a
  // first call is exactly when a quotable reference is most useful.
  const year = new Date().getFullYear();
  const sequence = (db.caseNumberSequence[year] ?? 0) + 1;
  db.caseNumberSequence = { ...db.caseNumberSequence, [year]: sequence };

  const referralSource = db.referralSources.find((r) => r.id === input.referralSourceId);

  const caseId = nextId();
  const loanCase: LoanCase = {
    id: caseId,
    caseNumber: formatCaseNumber({ year, sequence }),
    loanProductId: input.loanProductId,
    ...(input.requestedAmount ? { requestedAmount: input.requestedAmount } : {}),
    stage: "new",
    ownerUserId: actorUserId,
    // `source` is derived from the master-data pick so anything still
    // reading the free-text field (search, MIS exports) keeps working
    // (Milestone 5 — the field itself is kept for backward compatibility).
    ...(referralSource ? { source: referralSource.name, referralSourceId: referralSource.id } : {}),
    isOnHold: false,
    isInvoiceRaised: false,
    tags: [],
    createdAt: new Date().toISOString(),
  };

  db.cases = [...db.cases, loanCase];
  db.caseParties = [
    ...db.caseParties,
    { id: nextId(), caseId, personId, role: "applicant", isPrimary: true },
  ];

  record({
    actorUserId,
    caseId,
    entityType: "case",
    entityId: caseId,
    eventType: "case.created",
    summary: `Case ${loanCase.caseNumber} opened`,
  });

  regenerate(caseId, "Case created");
  commit();
  return caseId;
}

function regenerate(caseId: Id, cause: string): void {
  const before = db.requirements.filter((r) => r.caseId === caseId).length;
  const generated = applyExistingDocuments(
    db,
    regenerateRequirements(db, caseId, nextId),
  );
  db.requirements = [...db.requirements.filter((r) => r.caseId !== caseId), ...generated];

  const added = generated.length - before;
  if (added > 0 && before > 0) {
    record({
      caseId,
      entityType: "document_requirement",
      eventType: "requirements.generated",
      summary: `${added} new requirement${added === 1 ? "" : "s"} generated`,
      causedBy: cause,
    });
  }
}

export interface AddPartySubject {
  personId?: Id;
  organisationId?: Id;
  /** Search found nothing: create the person inline, same as at case creation. */
  newPersonName?: string;
  newPersonPhone?: string;
  /** Search found nothing: create the organisation inline (ADR-009 — typing a
   * name is the entire creation experience, there is no separate "new
   * organisation" form). */
  newOrganisationName?: string;
}

export function addParty(
  caseId: Id,
  role: CasePartyRole,
  subject: AddPartySubject,
  actorUserId: Id,
): ActionResult {
  let personId = subject.personId;
  let organisationId = subject.organisationId;

  if (!personId && !organisationId && subject.newPersonName?.trim()) {
    personId = nextId();
    db.people = [
      ...db.people,
      {
        id: personId,
        fullName: subject.newPersonName.trim(),
        aliases: [],
        identifiers: subject.newPersonPhone?.trim()
          ? [
              {
                id: nextId(),
                type: "phone",
                value: subject.newPersonPhone.trim(),
                isPrimary: true,
                verificationSource: "self_declared",
              },
            ]
          : [],
      },
    ];
    record({
      actorUserId,
      entityType: "person",
      entityId: personId,
      eventType: "person.created",
      summary: `Person created: ${subject.newPersonName.trim()}`,
    });
  } else if (!personId && !organisationId && subject.newOrganisationName?.trim()) {
    organisationId = nextId();
    db.organisations = [
      ...db.organisations,
      {
        id: organisationId,
        canonicalName: subject.newOrganisationName.trim(),
        roles: ["borrower"],
        aliases: [],
      },
    ];
    record({
      actorUserId,
      entityType: "organisation",
      entityId: organisationId,
      eventType: "organisation.created",
      summary: `Organisation created: ${subject.newOrganisationName.trim()}`,
    });
  }

  const person = db.people.find((p) => p.id === personId);
  const organisation = db.organisations.find((o) => o.id === organisationId);

  db.caseParties = [
    ...db.caseParties,
    {
      id: nextId(),
      caseId,
      ...(personId ? { personId } : {}),
      ...(organisationId ? { organisationId } : {}),
      role,
      isPrimary: false,
    },
  ];

  const name = person?.fullName ?? organisation?.canonicalName ?? "Party";
  const label = role.replace(/_/g, " ");

  const before = progressFor(caseId).percentComplete;
  regenerate(caseId, `${label} added`);
  const after = progressFor(caseId).percentComplete;

  record({
    actorUserId,
    caseId,
    entityType: "case_party",
    eventType: "case.party_added",
    // Progress moving backwards is correct and must not be hidden. An honest
    // number that moves is more useful than a flattering one that does not.
    summary:
      after < before
        ? `${label} added: ${name} — progress ${before}% → ${after}%`
        : `${label} added: ${name}`,
  });

  reconcileReadiness(caseId, `${label} added`);
  commit();
  return { ok: true };
}

export function setHold(
  caseId: Id,
  isOnHold: boolean,
  actorUserId: Id,
  reason?: string,
  until?: string,
): ActionResult {
  const loanCase = db.cases.find((c) => c.id === caseId);
  if (!loanCase) return { ok: false, message: "Case not found." };
  if (isOnHold && isTerminalStage(loanCase.stage)) {
    return { ok: false, message: "A closed or lost case cannot be put on hold." };
  }
  if (isOnHold && !reason) {
    return { ok: false, message: "A hold needs a reason." };
  }

  db.cases = db.cases.map((c) => {
    if (c.id !== caseId) return c;
    if (!isOnHold) {
      const { holdReason, holdUntil, ...rest } = c;
      return { ...rest, isOnHold: false };
    }
    return {
      ...c,
      isOnHold: true,
      ...(reason ? { holdReason: reason } : {}),
      ...(until ? { holdUntil: until } : {}),
    };
  });

  record({
    actorUserId,
    caseId,
    entityType: "case",
    entityId: caseId,
    eventType: isOnHold ? "case.held" : "case.hold_lifted",
    summary: isOnHold ? `Placed on hold: ${reason}` : "Hold lifted",
  });

  commit();
  return { ok: true };
}

export function assignOwner(caseId: Id, ownerUserId: Id, actorUserId: Id): ActionResult {
  const to = db.users.find((u) => u.id === ownerUserId);
  db.cases = db.cases.map((c) => (c.id === caseId ? { ...c, ownerUserId } : c));
  record({
    actorUserId,
    caseId,
    entityType: "case",
    entityId: caseId,
    eventType: "case.assigned",
    summary: `Owner changed to ${to?.name ?? "unknown"}`,
  });
  commit();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export async function uploadDocument(
  requirementId: Id,
  file: { name: string; size: number; bytes: Uint8Array; contentType?: string },
  actorUserId: Id,
): Promise<ActionResult> {
  const requirement = db.requirements.find((r) => r.id === requirementId);
  if (!requirement) return { ok: false, message: "Requirement not found." };

  const party = db.caseParties.find((p) => p.id === requirement.requiredOfCasePartyId);
  const caseProperty = db.caseProperties.find(
    (p) => p.id === requirement.requiredOfCasePropertyId,
  );
  const documentType = db.documentTypes.find((t) => t.id === requirement.documentTypeId);

  // Ownership is never asked of the user — it follows from what the
  // requirement is already known to be for (BR-030, ADR-007). This is the
  // same resolution uploadDocument has always done; it is now also what
  // decides the document's storage path, so "where does this file live" and
  // "who does this file belong to" can never disagree.
  const ownerKind = documentType?.ownerKind ?? "case";
  const ownerFields = {
    ownerKind,
    ...(party?.personId ? { personId: party.personId } : {}),
    ...(party?.organisationId ? { organisationId: party.organisationId } : {}),
    ...(caseProperty ? { propertyId: caseProperty.propertyId } : {}),
    ...(!party && !caseProperty ? { caseId: requirement.caseId } : {}),
  } as const;
  const owner = resolveDocumentOwner(ownerFields);

  // A previously-satisfied requirement being uploaded against again is a
  // replacement, not an overwrite (BR-031): the new document supersedes the
  // old one and takes the next version number, both stored under a new path
  // so the old bytes remain reachable.
  const previousDocument = db.documents.find((d) => d.id === requirement.satisfiedByDocumentId);
  const version = nextVersion(previousDocument);

  const filePath = buildStoragePath({
    owner,
    documentTypeCode: documentType?.code ?? "unknown",
    version,
    ...(requirement.periodStart ? { periodStart: requirement.periodStart } : {}),
    fileName: file.name,
  });
  await storageAdapter.put(
    filePath,
    file.bytes,
    file.contentType ? { contentType: file.contentType } : undefined,
  );

  const documentId = nextId();
  db.documents = [
    ...db.documents,
    {
      id: documentId,
      documentTypeId: requirement.documentTypeId,
      ...ownerFields,
      filePath,
      version,
      ...(previousDocument ? { supersedesDocumentId: previousDocument.id } : {}),
      // A financial-year-scoped requirement (e.g. "ITR — FY2024-25") already
      // pins the year — the row uploaded against is the year selector, so the
      // document inherits it rather than asking again.
      ...(requirement.periodStart ? { periodStart: requirement.periodStart } : {}),
      ...(requirement.periodEnd ? { periodEnd: requirement.periodEnd } : {}),
      fileName: file.name,
      fileSizeBytes: file.size,
      uploadedAt: new Date().toISOString(),
      uploadedBy: actorUserId,
    },
  ];

  db.requirements = db.requirements.map((r) =>
    r.id === requirementId
      ? { ...r, status: "received" as const, satisfiedByDocumentId: documentId }
      : r,
  );

  record({
    actorUserId,
    caseId: requirement.caseId,
    entityType: "document",
    entityId: documentId,
    eventType: "document.uploaded",
    summary: `${documentType?.name ?? "Document"} uploaded: ${file.name}`,
  });

  commit();
  return { ok: true };
}

export function verifyDocument(requirementId: Id, actorUserId: Id): ActionResult {
  const requirement = db.requirements.find((r) => r.id === requirementId);
  if (!requirement?.satisfiedByDocumentId) {
    return { ok: false, message: "Nothing has been uploaded against this requirement yet." };
  }

  const documentType = db.documentTypes.find((t) => t.id === requirement.documentTypeId);

  db.documents = db.documents.map((d) =>
    d.id === requirement.satisfiedByDocumentId
      ? { ...d, verifiedAt: new Date().toISOString(), verifiedBy: actorUserId }
      : d,
  );
  db.requirements = db.requirements.map((r) =>
    r.id === requirementId ? { ...r, status: "verified" as const } : r,
  );

  record({
    actorUserId,
    caseId: requirement.caseId,
    entityType: "document",
    entityId: requirement.satisfiedByDocumentId,
    eventType: "document.verified",
    summary: `${documentType?.name ?? "Document"} verified`,
  });

  reconcileReadiness(requirement.caseId, "Last applicable requirement verified");
  commit();
  return { ok: true };
}

export function waiveRequirement(
  requirementId: Id,
  reason: string,
  actorUserId: Id,
): ActionResult {
  if (!reason.trim()) {
    return { ok: false, message: "A waiver needs a reason. It is a decision with a name on it." };
  }

  const requirement = db.requirements.find((r) => r.id === requirementId);
  if (!requirement) return { ok: false, message: "Requirement not found." };

  const documentType = db.documentTypes.find((t) => t.id === requirement.documentTypeId);

  db.requirements = db.requirements.map((r) =>
    r.id === requirementId
      ? {
          ...r,
          status: "waived" as const,
          waivedBy: actorUserId,
          waivedAt: new Date().toISOString(),
          reason,
        }
      : r,
  );

  record({
    actorUserId,
    caseId: requirement.caseId,
    entityType: "document_requirement",
    entityId: requirementId,
    eventType: "requirement.waived",
    summary: `${documentType?.name ?? "Requirement"} waived: ${reason}`,
  });

  reconcileReadiness(requirement.caseId, "Requirement waived");
  commit();
  return { ok: true };
}

/**
 * Financial years selectable for a given group of requirement rows (same
 * document type and subject): the trailing window plus a few years further
 * back, minus whichever years already have a live row. This is the explicit
 * "request another year" control — a case's default requirement set covers
 * the common case, and a bank asking for one more year than usual is a real,
 * if less common, situation (Requirements and Progress Part 1: optional
 * participants and requirements are added by an explicit action, never a
 * form field sitting empty).
 */
export function selectableFinancialYears(
  caseId: Id,
  documentTypeId: Id,
  subject: { casePartyId?: Id; casePropertyId?: Id },
): Array<{ startDate: string; endDate: string; label: string }> {
  const taken = new Set(
    db.requirements
      .filter(
        (r) =>
          r.caseId === caseId &&
          r.documentTypeId === documentTypeId &&
          r.requiredOfCasePartyId === subject.casePartyId &&
          r.requiredOfCasePropertyId === subject.casePropertyId &&
          r.status !== "not_applicable" &&
          r.periodStart,
      )
      .map((r) => r.periodStart),
  );
  return recentFinancialYears(6).filter((fy) => !taken.has(fy.startDate));
}

export function addFinancialYearRequirement(
  caseId: Id,
  documentTypeId: Id,
  subject: { casePartyId?: Id; casePropertyId?: Id },
  financialYear: { startDate: string; endDate: string },
  actorUserId: Id,
): ActionResult {
  const alreadyRequested = db.requirements.some(
    (r) =>
      r.caseId === caseId &&
      r.documentTypeId === documentTypeId &&
      r.requiredOfCasePartyId === subject.casePartyId &&
      r.requiredOfCasePropertyId === subject.casePropertyId &&
      r.status !== "not_applicable" &&
      r.periodStart === financialYear.startDate,
  );
  if (alreadyRequested) {
    return { ok: false, message: "That financial year has already been requested." };
  }

  const documentType = db.documentTypes.find((t) => t.id === documentTypeId);
  const sibling = db.requirements.find(
    (r) =>
      r.caseId === caseId &&
      r.documentTypeId === documentTypeId &&
      r.requiredOfCasePartyId === subject.casePartyId &&
      r.requiredOfCasePropertyId === subject.casePropertyId,
  );

  const requirementId = nextId();
  db.requirements = [
    ...db.requirements,
    {
      id: requirementId,
      caseId,
      documentTypeId,
      ...(subject.casePartyId ? { requiredOfCasePartyId: subject.casePartyId } : {}),
      ...(subject.casePropertyId ? { requiredOfCasePropertyId: subject.casePropertyId } : {}),
      status: "pending" as const,
      applicableFromStage: sibling?.applicableFromStage ?? "documents_pending",
      periodStart: financialYear.startDate,
      periodEnd: financialYear.endDate,
    },
  ];

  record({
    actorUserId,
    caseId,
    entityType: "document_requirement",
    entityId: requirementId,
    eventType: "requirement.year_requested",
    summary: `${documentType?.name ?? "Requirement"} requested for an additional financial year`,
  });

  reconcileReadiness(caseId, "Additional financial year requested");
  commit();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

export function createSubmission(
  caseId: Id,
  branchOrganisationId: Id,
  actorUserId: Id,
): ActionResult {
  const branch = db.organisations.find((o) => o.id === branchOrganisationId);
  const submissionId = nextId();

  // Created in not_submitted: a bank, product and contact are chosen, but the
  // file has not physically gone out. The case stage advances on dispatch.
  db.submissions = [
    ...db.submissions,
    {
      id: submissionId,
      caseId,
      branchOrganisationId,
      status: "not_submitted",
      createdAt: new Date().toISOString(),
    },
  ];

  record({
    actorUserId,
    caseId,
    entityType: "submission",
    entityId: submissionId,
    eventType: "submission.created",
    summary: `Prepared for ${branch?.canonicalName ?? "bank"} — not yet dispatched`,
  });

  commit();
  return { ok: true };
}

export function updateSubmissionStatus(
  submissionId: Id,
  status: SubmissionStatus,
  actorUserId: Id,
  extra?: {
    rejectionReasonId?: Id | undefined;
    bankReasonText?: string | undefined;
    offer?: { amount: number; rate?: number | undefined; tenureMonths?: number | undefined };
  },
): ActionResult {
  const submission = db.submissions.find((s) => s.id === submissionId);
  if (!submission) return { ok: false, message: "Submission not found." };

  if (status === "rejected" && !extra?.rejectionReasonId) {
    return {
      ok: false,
      message:
        "A rejection needs a standardised category. Free text alone cannot be analysed (BR-024).",
    };
  }

  if (status === "sanctioned") {
    const hasOffer =
      db.offers.some((o) => o.submissionId === submissionId) || extra?.offer !== undefined;
    if (!hasOffer) {
      return {
        ok: false,
        message:
          "A sanction needs an offer attached. 'Sanctioned' with no amount, rate or tenure is not information (BR-023).",
      };
    }
  }

  if (status === "disbursed") {
    const alreadyDisbursed = db.submissions.some(
      (s) => s.caseId === submission.caseId && s.status === "disbursed" && s.id !== submissionId,
    );
    if (alreadyDisbursed) {
      return { ok: false, message: "This case already has a disbursed submission (BR-022)." };
    }
  }

  if (extra?.offer) {
    db.offers = [
      ...db.offers,
      {
        id: nextId(),
        submissionId,
        sanctionedAmount: extra.offer.amount,
        ...(extra.offer.rate ? { interestRate: extra.offer.rate } : {}),
        ...(extra.offer.tenureMonths ? { tenureMonths: extra.offer.tenureMonths } : {}),
        isAccepted: false,
      },
    ];
  }

  const dispatched = status !== "not_submitted" && !submission.submittedAt;

  db.submissions = db.submissions.map((s) =>
    s.id === submissionId
      ? {
          ...s,
          status,
          ...(dispatched ? { submittedAt: new Date().toISOString() } : {}),
          ...(extra?.rejectionReasonId ? { rejectionReasonId: extra.rejectionReasonId } : {}),
          ...(extra?.bankReasonText ? { bankReasonText: extra.bankReasonText } : {}),
        }
      : s,
  );

  const branch = db.organisations.find((o) => o.id === submission.branchOrganisationId);
  const reason = db.rejectionReasons.find((r) => r.id === extra?.rejectionReasonId);

  record({
    actorUserId,
    caseId: submission.caseId,
    entityType: "submission",
    entityId: submissionId,
    eventType: `submission.${status}`,
    summary:
      status === "rejected"
        ? `${branch?.canonicalName ?? "Bank"} rejected: ${reason?.name ?? "reason recorded"}`
        : `${branch?.canonicalName ?? "Bank"} → ${status.replace(/_/g, " ")}`,
  });

  autoAdvance(
    submission.caseId,
    `${branch?.canonicalName ?? "Bank"} ${status.replace(/_/g, " ")}`,
  );
  commit();
  return { ok: true };
}

export function acceptOffer(offerId: Id, actorUserId: Id): ActionResult {
  const offer = db.offers.find((o) => o.id === offerId);
  const submission = db.submissions.find((s) => s.id === offer?.submissionId);
  if (!offer || !submission) return { ok: false, message: "Offer not found." };

  db.offers = db.offers.map((o) =>
    o.id === offerId ? { ...o, isAccepted: true } : o,
  );

  // The unaccepted submissions go to Withdrawn, not Rejected. Withdrawn is our
  // choice to stop; rejected is theirs, and conflating them destroys the value
  // of the rejection dataset.
  const withdrawn = db.submissions.filter(
    (s) =>
      s.caseId === submission.caseId &&
      s.id !== submission.id &&
      !["rejected", "withdrawn", "disbursed"].includes(s.status),
  );

  db.submissions = db.submissions.map((s) =>
    withdrawn.some((w) => w.id === s.id) ? { ...s, status: "withdrawn" as const } : s,
  );

  record({
    actorUserId,
    caseId: submission.caseId,
    entityType: "offer",
    entityId: offerId,
    eventType: "offer.accepted",
    summary:
      withdrawn.length > 0
        ? `Offer accepted — ${withdrawn.length} other submission${withdrawn.length === 1 ? "" : "s"} withdrawn`
        : "Offer accepted",
  });

  commit();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Communication and notes
// ---------------------------------------------------------------------------

export function logCommunication(
  caseId: Id,
  personId: Id,
  channel: "call" | "whatsapp" | "email" | "sms" | "meeting",
  direction: "inbound" | "outbound",
  subject: string,
  body: string,
  actorUserId: Id,
): ActionResult {
  db.communications = [
    ...db.communications,
    {
      id: nextId(),
      caseId,
      personId,
      channel,
      direction,
      occurredAt: new Date().toISOString(),
      subject,
      body,
      recordedBy: actorUserId,
    },
  ];

  record({
    actorUserId,
    caseId,
    entityType: "communication",
    eventType: "communication.logged",
    summary: `${channel} logged: ${subject || "(no subject)"}`,
  });

  // First communication moves a New case to Contacted — the trigger stated in
  // the workflow table, not invented in the UI.
  const loanCase = db.cases.find((c) => c.id === caseId);
  if (loanCase?.stage === "new") {
    const outcome = evaluateTransition(snapshotOf(loanCase), {
      to: "contacted",
      actor: "user",
    });
    if (outcome.allowed) {
      db.cases = db.cases.map((c) =>
        c.id === caseId ? { ...c, stage: "contacted" as const } : c,
      );
      record({
        actorUserId,
        caseId,
        entityType: "case",
        entityId: caseId,
        eventType: "case.stage_changed",
        summary: "New → Contacted",
        causedBy: "First communication logged",
      });
    }
  }

  commit();
  return { ok: true };
}

export function addNote(caseId: Id, body: string, actorUserId: Id): ActionResult {
  if (!body.trim()) return { ok: false, message: "A note needs some content." };
  db.notes = [
    ...db.notes,
    { id: nextId(), caseId, authorId: actorUserId, body, createdAt: new Date().toISOString() },
  ];
  record({
    actorUserId,
    caseId,
    entityType: "note",
    eventType: "note.created",
    summary: "Note added",
  });
  commit();
  return { ok: true };
}

export function completeTask(taskId: Id, actorUserId: Id): ActionResult {
  const task = db.tasks.find((t) => t.id === taskId);
  db.tasks = db.tasks.map((t) =>
    t.id === taskId ? { ...t, completedAt: new Date().toISOString() } : t,
  );
  record({
    actorUserId,
    ...(task?.caseId ? { caseId: task.caseId } : {}),
    entityType: "task",
    entityId: taskId,
    eventType: "task.completed",
    summary: `Task completed: ${task?.title ?? ""}`,
  });
  commit();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Master Data Engine (Milestone 5)
//
// One generic CRUD surface over every table that shares MasterDataRecord's
// shape (code, name, description, is_active, display_order, effective_from,
// notes — Database/migrations/0012). Records are deactivated, never deleted,
// matching every other reference table in this schema (rejection_reason,
// document_type). Governed by master_data.manage, checked by the screen that
// calls these, not here — the fake store mirrors the domain layer's own
// stance that permission enforcement is the caller's job (BR-060).
// ---------------------------------------------------------------------------

/** The Database keys holding a MasterDataRecord[] collection. */
export const MASTER_DATA_KINDS = [
  "customerProducts",
  "employmentTypes",
  "businessConstitutions",
  "propertyTypes",
  "propertyOwnershipTypes",
  "referralSources",
  "districts",
  "cities",
  // Lending Product Catalogue (Milestone 7) — Database/migrations/0015.
  "borrowerTypes",
  "securityTypes",
  "requirementApplicabilities",
  // Bank & NBFC Catalogue (Milestone 8) — Database/migrations/0019.
  "lenderTypes",
  "lenderRelationshipRoles",
  "submissionModes",
  "lenderInsightCategories",
] as const;

export type MasterDataKind = (typeof MASTER_DATA_KINDS)[number];

export const MASTER_DATA_LABELS: Record<MasterDataKind, string> = {
  customerProducts: "Customer Product",
  employmentTypes: "Employment Type",
  businessConstitutions: "Business Constitution",
  propertyTypes: "Property Type",
  propertyOwnershipTypes: "Property Ownership Type",
  referralSources: "Referral Source",
  districts: "District",
  cities: "City",
  borrowerTypes: "Borrower Type",
  securityTypes: "Security Type",
  requirementApplicabilities: "Requirement Applicability",
  lenderTypes: "Lender Type",
  lenderRelationshipRoles: "Relationship Role",
  submissionModes: "Submission Mode",
  lenderInsightCategories: "Lender Note Category",
};

export interface MasterDataInput {
  code: string;
  name: string;
  description?: string;
  displayOrder?: number;
  effectiveFrom?: string;
  notes?: string;
  /** Only meaningful for `cities`. */
  districtId?: Id;
  /** Only meaningful for `districts`. */
  state?: string;
}

function masterDataList(kind: MasterDataKind): readonly MasterDataRecord[] {
  return db[kind];
}

function setMasterDataList(kind: MasterDataKind, list: readonly MasterDataRecord[]): void {
  db = { ...db, [kind]: list };
}

export function createMasterDataRecord(
  kind: MasterDataKind,
  input: MasterDataInput,
  actorUserId: Id,
): ActionResult {
  const code = input.code.trim();
  const name = input.name.trim();
  if (!code || !name) {
    return { ok: false, message: "Code and name are both required." };
  }
  if (masterDataList(kind).some((r) => r.code === code)) {
    return { ok: false, message: `"${code}" is already in use — codes must be unique.` };
  }

  const list = masterDataList(kind);
  const newRecord: MasterDataRecord = {
    id: nextId(),
    code,
    name,
    isActive: true,
    displayOrder: input.displayOrder ?? (list.length + 1) * 10,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(input.effectiveFrom ? { effectiveFrom: input.effectiveFrom } : {}),
    ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
    ...(kind === "cities" && input.districtId ? { districtId: input.districtId } : {}),
    ...(kind === "districts" && input.state?.trim() ? { state: input.state.trim() } : {}),
  };
  setMasterDataList(kind, [...list, newRecord]);

  record({
    actorUserId,
    entityType: kind,
    entityId: newRecord.id,
    eventType: "master_data.created",
    summary: `${MASTER_DATA_LABELS[kind]} added: ${name}`,
  });

  commit();
  return { ok: true };
}

export function updateMasterDataRecord(
  kind: MasterDataKind,
  id: Id,
  patch: Partial<MasterDataInput>,
  actorUserId: Id,
): ActionResult {
  const existing = masterDataList(kind).find((r) => r.id === id);
  if (!existing) return { ok: false, message: "Record not found." };

  const name = patch.name?.trim();
  if (patch.name !== undefined && !name) {
    return { ok: false, message: "Name cannot be blank." };
  }

  setMasterDataList(
    kind,
    masterDataList(kind).map((r) => {
      if (r.id !== id) return r;
      const { description, notes, effectiveFrom, districtId, state, ...rest } = r;
      return {
        ...rest,
        ...(description !== undefined ? { description } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(effectiveFrom !== undefined ? { effectiveFrom } : {}),
        ...(districtId !== undefined ? { districtId } : {}),
        ...(state !== undefined ? { state } : {}),
        ...(name ? { name } : {}),
        ...(patch.displayOrder !== undefined ? { displayOrder: patch.displayOrder } : {}),
        ...(patch.description?.trim() ? { description: patch.description.trim() } : {}),
        ...(patch.effectiveFrom ? { effectiveFrom: patch.effectiveFrom } : {}),
        ...(patch.notes?.trim() ? { notes: patch.notes.trim() } : {}),
        ...(kind === "cities" && patch.districtId ? { districtId: patch.districtId } : {}),
        ...(kind === "districts" && patch.state?.trim() ? { state: patch.state.trim() } : {}),
      };
    }),
  );

  record({
    actorUserId,
    entityType: kind,
    entityId: id,
    eventType: "master_data.updated",
    summary: `${MASTER_DATA_LABELS[kind]} updated: ${name ?? existing.name}`,
  });

  commit();
  return { ok: true };
}

export function setMasterDataActive(
  kind: MasterDataKind,
  id: Id,
  isActive: boolean,
  actorUserId: Id,
): ActionResult {
  const existing = masterDataList(kind).find((r) => r.id === id);
  if (!existing) return { ok: false, message: "Record not found." };

  setMasterDataList(
    kind,
    masterDataList(kind).map((r) => (r.id === id ? { ...r, isActive } : r)),
  );

  record({
    actorUserId,
    entityType: kind,
    entityId: id,
    eventType: isActive ? "master_data.activated" : "master_data.deactivated",
    summary: `${MASTER_DATA_LABELS[kind]} ${isActive ? "reactivated" : "deactivated"}: ${existing.name}`,
  });

  commit();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Document types and rejection reasons — already master data before this
// milestone (ADR-025, ADR-028), but with no admin screen. Their extra fields
// (owner_kind / requires_period / requires_expiry) keep them out of the
// generic MasterDataRecord functions above; these mirror those functions for
// the two fields every master-data table shares: name/description and
// is_active.
// ---------------------------------------------------------------------------

export function updateDocumentTypeDetails(
  id: Id,
  patch: { name?: string; description?: string },
  actorUserId: Id,
): ActionResult {
  const existing = db.documentTypes.find((t) => t.id === id);
  if (!existing) return { ok: false, message: "Document type not found." };
  const name = patch.name?.trim();
  if (patch.name !== undefined && !name) return { ok: false, message: "Name cannot be blank." };

  db.documentTypes = db.documentTypes.map((t) =>
    t.id === id
      ? {
          ...t,
          ...(name ? { name } : {}),
          ...(patch.description?.trim() ? { description: patch.description.trim() } : {}),
        }
      : t,
  );
  record({
    actorUserId,
    entityType: "document_type",
    entityId: id,
    eventType: "master_data.updated",
    summary: `Document Type updated: ${name ?? existing.name}`,
  });
  commit();
  return { ok: true };
}

export function setDocumentTypeActive(id: Id, isActive: boolean, actorUserId: Id): ActionResult {
  const existing = db.documentTypes.find((t) => t.id === id);
  if (!existing) return { ok: false, message: "Document type not found." };
  db.documentTypes = db.documentTypes.map((t) => (t.id === id ? { ...t, isActive } : t));
  record({
    actorUserId,
    entityType: "document_type",
    entityId: id,
    eventType: isActive ? "master_data.activated" : "master_data.deactivated",
    summary: `Document Type ${isActive ? "reactivated" : "deactivated"}: ${existing.name}`,
  });
  commit();
  return { ok: true };
}

export function updateRejectionReasonDetails(
  id: Id,
  patch: { name?: string; description?: string },
  actorUserId: Id,
): ActionResult {
  const existing = db.rejectionReasons.find((r) => r.id === id);
  if (!existing) return { ok: false, message: "Rejection reason not found." };
  const name = patch.name?.trim();
  if (patch.name !== undefined && !name) return { ok: false, message: "Name cannot be blank." };

  db.rejectionReasons = db.rejectionReasons.map((r) =>
    r.id === id
      ? {
          ...r,
          ...(name ? { name } : {}),
          ...(patch.description?.trim() ? { description: patch.description.trim() } : {}),
        }
      : r,
  );
  record({
    actorUserId,
    entityType: "rejection_reason",
    entityId: id,
    eventType: "master_data.updated",
    summary: `Rejection Reason updated: ${name ?? existing.name}`,
  });
  commit();
  return { ok: true };
}

export function setRejectionReasonActive(id: Id, isActive: boolean, actorUserId: Id): ActionResult {
  const existing = db.rejectionReasons.find((r) => r.id === id);
  if (!existing) return { ok: false, message: "Rejection reason not found." };
  db.rejectionReasons = db.rejectionReasons.map((r) => (r.id === id ? { ...r, isActive } : r));
  record({
    actorUserId,
    entityType: "rejection_reason",
    entityId: id,
    eventType: isActive ? "master_data.activated" : "master_data.deactivated",
    summary: `Rejection Reason ${isActive ? "reactivated" : "deactivated"}: ${existing.name}`,
  });
  commit();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Lending Product Catalogue (Milestone 7) — Database/migrations/0015.
//
// A lending product is richer than a MasterDataRecord (a category, a security
// type, three many-to-many eligibility lists, tenure and amount ranges), so
// it does not go through the generic functions above — the same reason
// document_type and rejection_reason have their own. What it shares with
// them: records are deactivated, never deleted, and every write pairs with an
// event (BR-050).
//
// Governed by master_data.manage, checked by the screen that calls these
// (BR-060), as everywhere else in this store.
// ---------------------------------------------------------------------------

export interface LendingProductInput {
  code: string;
  name: string;
  customerProductId: Id;
  description?: string;
  securityTypeId?: Id;
  propertyRequirementId?: Id;
  gstRequirementId?: Id;
  borrowerTypeIds?: Id[];
  employmentTypeIds?: Id[];
  businessConstitutionIds?: Id[];
  minTenureMonths?: number;
  maxTenureMonths?: number;
  minAmount?: number;
  maxAmount?: number;
  effectiveFrom?: string;
  effectiveTo?: string;
  typicalCustomerProfile?: string;
  typicalDocumentsSummary?: string;
  notes?: string;
}

/**
 * Rejects what the database's own check constraints would reject, in the
 * words an office user would use. The constraint is the real guard; this
 * exists so the message arrives before the save rather than after it.
 */
function validateLendingProduct(input: LendingProductInput): string | undefined {
  if (!input.code.trim() || !input.name.trim()) return "Code and product name are both required.";
  if (!/^[a-z][a-z0-9_]*$/.test(input.code.trim())) {
    return "Code must be lowercase letters, numbers and underscores, starting with a letter.";
  }
  if (!input.customerProductId) return "Every product belongs to a customer product.";
  const { minTenureMonths: minT, maxTenureMonths: maxT, minAmount, maxAmount } = input;
  if (minT !== undefined && maxT !== undefined && maxT < minT) {
    return "Maximum tenure cannot be shorter than the minimum.";
  }
  if (minAmount !== undefined && maxAmount !== undefined && maxAmount < minAmount) {
    return "Maximum amount cannot be less than the minimum.";
  }
  if (input.effectiveFrom && input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    return "The last effective date cannot be before the first.";
  }
  return undefined;
}

/** Only the fields the input actually carries — exactOptionalPropertyTypes. */
function lendingProductFields(input: LendingProductInput): Partial<LoanProduct> {
  return {
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(input.securityTypeId ? { securityTypeId: input.securityTypeId } : {}),
    ...(input.propertyRequirementId ? { propertyRequirementId: input.propertyRequirementId } : {}),
    ...(input.gstRequirementId ? { gstRequirementId: input.gstRequirementId } : {}),
    ...(input.borrowerTypeIds ? { borrowerTypeIds: [...input.borrowerTypeIds] } : {}),
    ...(input.employmentTypeIds ? { employmentTypeIds: [...input.employmentTypeIds] } : {}),
    ...(input.businessConstitutionIds
      ? { businessConstitutionIds: [...input.businessConstitutionIds] }
      : {}),
    ...(input.minTenureMonths !== undefined ? { minTenureMonths: input.minTenureMonths } : {}),
    ...(input.maxTenureMonths !== undefined ? { maxTenureMonths: input.maxTenureMonths } : {}),
    ...(input.minAmount !== undefined ? { minAmount: input.minAmount } : {}),
    ...(input.maxAmount !== undefined ? { maxAmount: input.maxAmount } : {}),
    ...(input.effectiveFrom ? { effectiveFrom: input.effectiveFrom } : {}),
    ...(input.effectiveTo ? { effectiveTo: input.effectiveTo } : {}),
    ...(input.typicalCustomerProfile?.trim()
      ? { typicalCustomerProfile: input.typicalCustomerProfile.trim() }
      : {}),
    ...(input.typicalDocumentsSummary?.trim()
      ? { typicalDocumentsSummary: input.typicalDocumentsSummary.trim() }
      : {}),
    ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
  };
}

export function createLendingProduct(input: LendingProductInput, actorUserId: Id): ActionResult {
  const problem = validateLendingProduct(input);
  if (problem) return { ok: false, message: problem };

  const code = input.code.trim();
  const name = input.name.trim();
  if (db.loanProducts.some((p) => p.code === code)) {
    return { ok: false, message: `"${code}" is already in use — product codes must be unique.` };
  }
  const customerProduct = db.customerProducts.find((c) => c.id === input.customerProductId);
  if (!customerProduct) return { ok: false, message: "That customer product no longer exists." };

  const product: LoanProduct = {
    id: nextId(),
    code,
    // The legacy free-text pair, still written so nothing reading it breaks
    // (Database/migrations/0015).
    category: customerProduct.name,
    variant: name,
    customerProductId: customerProduct.id,
    name,
    isActive: true,
    availabilityStatus: "active",
    displayOrder: (db.loanProducts.length + 1) * 10,
    ...lendingProductFields(input),
  };
  db = { ...db, loanProducts: [...db.loanProducts, product] };

  record({
    actorUserId,
    entityType: "loan_product",
    entityId: product.id,
    eventType: "master_data.created",
    summary: `Lending product added: ${name}`,
  });
  commit();
  return { ok: true };
}

export function updateLendingProduct(
  id: Id,
  input: LendingProductInput,
  actorUserId: Id,
): ActionResult {
  const existing = db.loanProducts.find((p) => p.id === id);
  if (!existing) return { ok: false, message: "Product not found." };
  const problem = validateLendingProduct(input);
  if (problem) return { ok: false, message: problem };

  const name = input.name.trim();
  const customerProduct = db.customerProducts.find((c) => c.id === input.customerProductId);
  if (!customerProduct) return { ok: false, message: "That customer product no longer exists." };

  db = {
    ...db,
    loanProducts: db.loanProducts.map((p) =>
      p.id === id
        ? {
            // Rebuilt rather than merged: an eligibility list the user
            // cleared must stay cleared, and spreading the old row would
            // silently keep what was just unticked.
            id: p.id,
            code: p.code,
            category: customerProduct.name,
            variant: name,
            customerProductId: customerProduct.id,
            name,
            isActive: p.isActive,
            availabilityStatus: p.availabilityStatus ?? (p.isActive ? "active" : "retired"),
            displayOrder: p.displayOrder,
            ...(p.supersedesLoanProductId
              ? { supersedesLoanProductId: p.supersedesLoanProductId }
              : {}),
            ...lendingProductFields(input),
          }
        : p,
    ),
  };

  record({
    actorUserId,
    entityType: "loan_product",
    entityId: id,
    eventType: "master_data.updated",
    summary: `Lending product updated: ${name}`,
  });
  commit();
  return { ok: true };
}

/**
 * Sets the full three-state lifecycle (Milestone 7.1, ADR-033).
 * `isActive` is kept in lockstep — true only for `"active"` — the same
 * consistency the database enforces with a check constraint
 * (Database/migrations/0017), so every reader that only knows `isActive`
 * still gets the right on/off answer.
 */
export function setLendingProductAvailability(
  id: Id,
  status: AvailabilityStatus,
  actorUserId: Id,
): ActionResult {
  const existing = db.loanProducts.find((p) => p.id === id);
  if (!existing) return { ok: false, message: "Product not found." };

  db = {
    ...db,
    loanProducts: db.loanProducts.map((p) =>
      p.id === id ? { ...p, availabilityStatus: status, isActive: status === "active" } : p,
    ),
  };

  const labels: Record<AvailabilityStatus, string> = {
    active: "reactivated",
    temporarily_suspended: "temporarily suspended",
    retired: "retired",
  };
  record({
    actorUserId,
    entityType: "loan_product",
    entityId: id,
    eventType: status === "active" ? "master_data.activated" : "master_data.deactivated",
    summary: `Lending product ${labels[status]}: ${existing.name ?? existing.variant}`,
  });
  commit();
  return { ok: true };
}

/** Thin two-state wrapper over {@link setLendingProductAvailability}, kept
 * for callers that only reason in Active/Inactive terms. */
export function setLendingProductActive(id: Id, isActive: boolean, actorUserId: Id): ActionResult {
  return setLendingProductAvailability(id, isActive ? "active" : "retired", actorUserId);
}

/**
 * Projects the stored products into the domain layer's shape — ids resolved
 * to codes, which is what @domain/products reasons about.
 *
 * The same translation the server will do when it loads a product out of
 * Postgres, done here so the catalogue screen filters through the real
 * domain code rather than through a second implementation of it.
 */
export function lendingProductsAsDomain(source: Database = db): LendingProduct[] {
  const codeOf = (list: readonly MasterDataRecord[], id?: Id): string | undefined =>
    id === undefined ? undefined : list.find((r) => r.id === id)?.code;
  const codesOf = (list: readonly MasterDataRecord[], ids?: readonly Id[]): string[] | undefined =>
    ids === undefined
      ? undefined
      : ids.flatMap((id) => {
          const code = codeOf(list, id);
          return code === undefined ? [] : [code];
        });

  return source.loanProducts.map((product) => ({
    code: product.code,
    name: product.name ?? `${product.category} — ${product.variant}`,
    customerProductCode: codeOf(source.customerProducts, product.customerProductId),
    description: product.description,
    securityTypeCode: codeOf(source.securityTypes, product.securityTypeId),
    borrowerTypeCodes: codesOf(source.borrowerTypes, product.borrowerTypeIds),
    employmentTypeCodes: codesOf(source.employmentTypes, product.employmentTypeIds),
    businessConstitutionCodes: codesOf(
      source.businessConstitutions,
      product.businessConstitutionIds,
    ),
    propertyRequirement: codeOf(source.requirementApplicabilities, product.propertyRequirementId),
    gstRequirement: codeOf(source.requirementApplicabilities, product.gstRequirementId),
    minTenureMonths: product.minTenureMonths,
    maxTenureMonths: product.maxTenureMonths,
    minAmount: product.minAmount,
    maxAmount: product.maxAmount,
    isActive: product.isActive,
    availabilityStatus: product.availabilityStatus,
    effectiveFrom: product.effectiveFrom,
    effectiveTo: product.effectiveTo,
    supersedesProductCode: source.loanProducts.find((p) => p.id === product.supersedesLoanProductId)
      ?.code,
    typicalCustomerProfile: product.typicalCustomerProfile,
    typicalDocumentsSummary: product.typicalDocumentsSummary,
  }));
}

// ---------------------------------------------------------------------------
// Bank & NBFC Catalogue (Milestone 8) â€” Database/migrations/0019, 0020.
//
// Five concepts, kept apart here exactly as the schema keeps them apart:
// institution, branch, relationship manager, supported product, submission
// rule â€” plus the lender profile notes that fit into none of them.
//
// An institution is an organisation holding the `lender` role plus a
// LenderProfile; a branch is an organisation holding the `branch` role plus a
// BankBranch. Nothing here creates a second "bank" entity beside
// organisation, because that is how "IIFL" ends up in the database three
// times (ADR-014).
//
// Records are deactivated, never deleted, and every write pairs with an event
// (BR-050). Governed by master_data.manage, checked by the screen that calls
// these (BR-060), as everywhere else in this store.
// ---------------------------------------------------------------------------

const trimmed = (value?: string): string | undefined => (value?.trim() ? value.trim() : undefined);

export interface InstitutionInput {
  name: string;
  code: string;
  lenderTypeId: Id;
  headOfficeCity?: string;
  primaryServiceRegion?: string;
  websiteUrl?: string;
  isOnPanel: boolean;
  typicalTurnaroundDays?: number;
  preferredCustomerSegments?: string;
  knownStrengths?: string;
  knownLimitations?: string;
  commonRejectionPatterns?: string;
  internalRemarks?: string;
  notes?: string;
}

/**
 * Rejects what the database's own check constraints would reject, in the
 * words an office user would use â€” the same division of labour the lending
 * product catalogue uses. The constraint is the real guard; this exists so
 * the message arrives before the save rather than after it.
 */
function validateInstitution(input: InstitutionInput): string | undefined {
  if (!input.name.trim()) return "The lender's name is required.";
  if (!input.code.trim()) return "A short code is required â€” it is what reports key on.";
  if (!/^[a-z][a-z0-9_]*$/.test(input.code.trim())) {
    return "Code must be lowercase letters, numbers and underscores, starting with a letter.";
  }
  if (!input.lenderTypeId) return "Choose what kind of lender this is.";
  if (input.typicalTurnaroundDays !== undefined && input.typicalTurnaroundDays <= 0) {
    return "Turnaround time must be a positive number of days.";
  }
  return undefined;
}

/** Only the fields the input actually carries â€” exactOptionalPropertyTypes. */
function institutionFields(input: InstitutionInput): Partial<LenderProfile> {
  return {
    ...(trimmed(input.headOfficeCity) ? { headOfficeCity: trimmed(input.headOfficeCity) as string } : {}),
    ...(trimmed(input.primaryServiceRegion)
      ? { primaryServiceRegion: trimmed(input.primaryServiceRegion) as string }
      : {}),
    ...(trimmed(input.websiteUrl) ? { websiteUrl: trimmed(input.websiteUrl) as string } : {}),
    ...(input.typicalTurnaroundDays !== undefined
      ? { typicalTurnaroundDays: input.typicalTurnaroundDays }
      : {}),
    ...(trimmed(input.preferredCustomerSegments)
      ? { preferredCustomerSegments: trimmed(input.preferredCustomerSegments) as string }
      : {}),
    ...(trimmed(input.knownStrengths) ? { knownStrengths: trimmed(input.knownStrengths) as string } : {}),
    ...(trimmed(input.knownLimitations)
      ? { knownLimitations: trimmed(input.knownLimitations) as string }
      : {}),
    ...(trimmed(input.commonRejectionPatterns)
      ? { commonRejectionPatterns: trimmed(input.commonRejectionPatterns) as string }
      : {}),
    ...(trimmed(input.internalRemarks)
      ? { internalRemarks: trimmed(input.internalRemarks) as string }
      : {}),
    ...(trimmed(input.notes) ? { notes: trimmed(input.notes) as string } : {}),
  };
}

/** Maps a master-data lender type onto the three-value legacy enum. A Small
 * Finance Bank and a Regional Rural Bank are both banks â€” a widening, never a
 * lie (Database/migrations/0019). */
function legacyLenderType(code: string): LenderProfile["lenderType"] {
  if (code === "nbfc") return "nbfc";
  if (code === "housing_finance_company") return "hfc";
  return "bank";
}

/**
 * Adds a lender: one organisation row carrying the `lender` role, and one
 * lender profile beside it.
 */
export function createInstitution(input: InstitutionInput, actorUserId: Id): ActionResult {
  const problem = validateInstitution(input);
  if (problem) return { ok: false, message: problem };

  const name = input.name.trim();
  const code = input.code.trim();
  if (db.lenderProfiles.some((profile) => profile.code === code)) {
    return { ok: false, message: `"${code}" is already in use â€” lender codes must be unique.` };
  }
  // A near-match is a suggestion and never a refusal (Principle #7), but an
  // exact duplicate name almost always means somebody did not find the row
  // that is already there, and a second "HDFC Bank" is precisely what
  // modelling lenders as organisations exists to prevent (ADR-014).
  const duplicate = db.organisations.find(
    (org) => org.roles.includes("lender") && org.canonicalName.toLowerCase() === name.toLowerCase(),
  );
  if (duplicate) {
    return { ok: false, message: `${duplicate.canonicalName} is already in the catalogue.` };
  }

  const lenderType = db.lenderTypes.find((type) => type.id === input.lenderTypeId);
  if (!lenderType) return { ok: false, message: "That lender type no longer exists." };

  const organisationId = nextId();
  const organisation: Organisation = {
    id: organisationId,
    canonicalName: name,
    roles: ["lender"],
    industry: "Banking and Finance",
    aliases: [],
    isActive: true,
    ...(trimmed(input.headOfficeCity) ? { city: trimmed(input.headOfficeCity) as string } : {}),
  };
  const profile: LenderProfile = {
    organisationId,
    lenderTypeId: lenderType.id,
    // The legacy enum, still written so nothing reading it breaks.
    lenderType: legacyLenderType(lenderType.code),
    code,
    isOnPanel: input.isOnPanel,
    displayOrder: (db.lenderProfiles.length + 1) * 10,
    ...institutionFields(input),
  };

  db = {
    ...db,
    organisations: [...db.organisations, organisation],
    lenderProfiles: [...db.lenderProfiles, profile],
  };

  record({
    actorUserId,
    entityType: "lender_profile",
    entityId: organisationId,
    eventType: "master_data.created",
    summary: `Lender added: ${name}`,
  });
  commit();
  return { ok: true };
}

export function updateInstitution(
  organisationId: Id,
  input: InstitutionInput,
  actorUserId: Id,
): ActionResult {
  const existing = db.lenderProfiles.find((p) => p.organisationId === organisationId);
  if (!existing) return { ok: false, message: "Lender not found." };
  const problem = validateInstitution(input);
  if (problem) return { ok: false, message: problem };

  const name = input.name.trim();
  const code = input.code.trim();
  if (db.lenderProfiles.some((p) => p.code === code && p.organisationId !== organisationId)) {
    return { ok: false, message: `"${code}" is already in use â€” lender codes must be unique.` };
  }
  const lenderType = db.lenderTypes.find((type) => type.id === input.lenderTypeId);
  if (!lenderType) return { ok: false, message: "That lender type no longer exists." };

  db = {
    ...db,
    organisations: db.organisations.map((org) =>
      org.id === organisationId
        ? {
            ...org,
            canonicalName: name,
            ...(trimmed(input.headOfficeCity) ? { city: trimmed(input.headOfficeCity) as string } : {}),
          }
        : org,
    ),
    lenderProfiles: db.lenderProfiles.map((profile) =>
      profile.organisationId === organisationId
        ? {
            // Rebuilt rather than merged, the same reasoning the lending
            // product catalogue uses: a field the user cleared must stay
            // cleared, and spreading the old row would silently keep it.
            organisationId: profile.organisationId,
            lenderTypeId: lenderType.id,
            lenderType: legacyLenderType(lenderType.code),
            code,
            isOnPanel: input.isOnPanel,
            displayOrder: profile.displayOrder,
            ...institutionFields(input),
          }
        : profile,
    ),
  };

  record({
    actorUserId,
    entityType: "lender_profile",
    entityId: organisationId,
    eventType: "master_data.updated",
    summary: `Lender updated: ${name}`,
  });
  commit();
  return { ok: true };
}

/**
 * Whether the lender still exists at all â€” deliberately distinct from panel
 * status, which is on the form above. Lakshmi Vilas Bank is inactive because
 * it ceased to exist; a lender Amaze has simply stopped using is off panel
 * and could be back next month.
 */
export function setInstitutionActive(
  organisationId: Id,
  isActive: boolean,
  actorUserId: Id,
): ActionResult {
  const organisation = db.organisations.find((org) => org.id === organisationId);
  if (!organisation) return { ok: false, message: "Lender not found." };

  db = {
    ...db,
    organisations: db.organisations.map((org) =>
      org.id === organisationId ? { ...org, isActive } : org,
    ),
  };

  record({
    actorUserId,
    entityType: "lender_profile",
    entityId: organisationId,
    eventType: isActive ? "master_data.activated" : "master_data.deactivated",
    summary: `Lender ${isActive ? "reactivated" : "deactivated"}: ${organisation.canonicalName}`,
  });
  commit();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export interface BranchInput {
  institutionOrganisationId: Id;
  name: string;
  branchCode?: string;
  cityId?: Id;
  districtId?: Id;
  addressLine?: string;
  contactNumber?: string;
  email?: string;
  operationalStatus: BranchStatus;
  notes?: string;
}

function branchFields(input: BranchInput): Partial<BankBranch> {
  return {
    ...(trimmed(input.branchCode) ? { branchCode: trimmed(input.branchCode) as string } : {}),
    ...(input.cityId ? { cityId: input.cityId } : {}),
    ...(input.districtId ? { districtId: input.districtId } : {}),
    ...(trimmed(input.addressLine) ? { addressLine: trimmed(input.addressLine) as string } : {}),
    ...(trimmed(input.contactNumber) ? { contactNumber: trimmed(input.contactNumber) as string } : {}),
    ...(trimmed(input.email) ? { email: trimmed(input.email) as string } : {}),
    ...(trimmed(input.notes) ? { notes: trimmed(input.notes) as string } : {}),
  };
}

export function createBranch(input: BranchInput, actorUserId: Id): ActionResult {
  if (!input.name.trim()) return { ok: false, message: "The branch name is required." };
  const institution = db.organisations.find((org) => org.id === input.institutionOrganisationId);
  if (!institution) return { ok: false, message: "That lender no longer exists." };

  const organisationId = nextId();
  const organisation: Organisation = {
    id: organisationId,
    canonicalName: input.name.trim(),
    roles: ["branch"],
    industry: "Banking and Finance",
    parentOrganisationId: institution.id,
    aliases: [],
    isActive: true,
  };
  const branch: BankBranch = {
    organisationId,
    operationalStatus: input.operationalStatus,
    displayOrder: (db.bankBranches.length + 1) * 10,
    ...branchFields(input),
  };

  db = {
    ...db,
    organisations: [...db.organisations, organisation],
    bankBranches: [...db.bankBranches, branch],
  };

  record({
    actorUserId,
    entityType: "bank_branch",
    entityId: organisationId,
    eventType: "master_data.created",
    summary: `Branch added: ${organisation.canonicalName}`,
  });
  commit();
  return { ok: true };
}

export function updateBranch(organisationId: Id, input: BranchInput, actorUserId: Id): ActionResult {
  const existing = db.bankBranches.find((branch) => branch.organisationId === organisationId);
  if (!existing) return { ok: false, message: "Branch not found." };
  if (!input.name.trim()) return { ok: false, message: "The branch name is required." };

  db = {
    ...db,
    organisations: db.organisations.map((org) =>
      org.id === organisationId ? { ...org, canonicalName: input.name.trim() } : org,
    ),
    bankBranches: db.bankBranches.map((branch) =>
      branch.organisationId === organisationId
        ? {
            organisationId: branch.organisationId,
            operationalStatus: input.operationalStatus,
            displayOrder: branch.displayOrder,
            ...branchFields(input),
          }
        : branch,
    ),
  };

  record({
    actorUserId,
    entityType: "bank_branch",
    entityId: organisationId,
    eventType: "master_data.updated",
    summary: `Branch updated: ${input.name.trim()}`,
  });
  commit();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Relationship managers
//
// A person plus a relationship, never a standalone "RM" row: a manager who
// moves to another bank next year is one new relationship, not a second
// person (ADR-013, ADR-014).
// ---------------------------------------------------------------------------

export interface RelationshipManagerInput {
  fullName: string;
  institutionOrganisationId: Id;
  /** Optional â€” a regional manager belongs to no single branch, and that is
   * a complete record rather than a partial one. */
  branchOrganisationId?: Id;
  relationshipRoleId?: Id;
  designation?: string;
  workMobile?: string;
  workEmail?: string;
  notes?: string;
}

function contactFields(input: RelationshipManagerInput): Partial<BankContact> {
  return {
    ...(input.branchOrganisationId ? { branchOrganisationId: input.branchOrganisationId } : {}),
    ...(input.relationshipRoleId ? { relationshipRoleId: input.relationshipRoleId } : {}),
    ...(trimmed(input.designation) ? { designation: trimmed(input.designation) as string } : {}),
    ...(trimmed(input.workMobile) ? { workMobile: trimmed(input.workMobile) as string } : {}),
    ...(trimmed(input.workEmail) ? { workEmail: trimmed(input.workEmail) as string } : {}),
    ...(trimmed(input.notes) ? { notes: trimmed(input.notes) as string } : {}),
  };
}

export function createRelationshipManager(
  input: RelationshipManagerInput,
  actorUserId: Id,
): ActionResult {
  const name = input.fullName.trim();
  if (!name) return { ok: false, message: "The manager's name is required." };
  const institution = db.organisations.find((org) => org.id === input.institutionOrganisationId);
  if (!institution) return { ok: false, message: "That lender no longer exists." };

  // The person row is created here rather than searched for: a bank manager
  // is almost never already in the system, and the search-first picker
  // belongs on a case. When identity resolution runs over this screen it
  // replaces these two lines and nothing else.
  const personId = nextId();
  const person: Person = { id: personId, fullName: name, aliases: [], identifiers: [] };

  const contact: BankContact = {
    id: nextId(),
    personId,
    institutionOrganisationId: institution.id,
    isActive: true,
    ...contactFields(input),
  };

  db = { ...db, people: [...db.people, person], bankContacts: [...db.bankContacts, contact] };

  record({
    actorUserId,
    entityType: "bank_contact",
    entityId: contact.id,
    eventType: "master_data.created",
    summary: `Contact added at ${institution.canonicalName}: ${name}`,
  });
  commit();
  return { ok: true };
}

export function updateRelationshipManager(
  contactId: Id,
  input: RelationshipManagerInput,
  actorUserId: Id,
): ActionResult {
  const existing = db.bankContacts.find((contact) => contact.id === contactId);
  if (!existing) return { ok: false, message: "Contact not found." };
  const name = input.fullName.trim();
  if (!name) return { ok: false, message: "The manager's name is required." };
  if (!db.organisations.some((org) => org.id === input.institutionOrganisationId)) {
    return { ok: false, message: "That lender no longer exists." };
  }

  db = {
    ...db,
    people: db.people.map((person) =>
      person.id === existing.personId ? { ...person, fullName: name } : person,
    ),
    bankContacts: db.bankContacts.map((contact) =>
      contact.id === contactId
        ? {
            id: contact.id,
            personId: contact.personId,
            institutionOrganisationId: input.institutionOrganisationId,
            isActive: contact.isActive,
            ...contactFields(input),
          }
        : contact,
    ),
  };

  record({
    actorUserId,
    entityType: "bank_contact",
    entityId: contactId,
    eventType: "master_data.updated",
    summary: `Contact updated: ${name}`,
  });
  commit();
  return { ok: true };
}

/** Deactivated, never deleted: a manager who has moved on is history worth
 * keeping, and older submissions still name them. */
export function setRelationshipManagerActive(
  contactId: Id,
  isActive: boolean,
  actorUserId: Id,
): ActionResult {
  const existing = db.bankContacts.find((contact) => contact.id === contactId);
  if (!existing) return { ok: false, message: "Contact not found." };
  const person = db.people.find((p) => p.id === existing.personId);

  db = {
    ...db,
    bankContacts: db.bankContacts.map((contact) =>
      contact.id === contactId ? { ...contact, isActive } : contact,
    ),
  };

  record({
    actorUserId,
    entityType: "bank_contact",
    entityId: contactId,
    eventType: isActive ? "master_data.activated" : "master_data.deactivated",
    summary: `Contact ${isActive ? "reactivated" : "marked as moved on"}: ${person?.fullName ?? "Unknown"}`,
  });
  commit();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Supported products
//
// A pointer at the Lending Product Catalogue, never a second definition of a
// product (Database/migrations/0019, Part 5).
// ---------------------------------------------------------------------------

export interface SupportedProductInput {
  organisationId: Id;
  loanProductId: Id;
  /** The lender's own name for it. Defaults to the lending product's name,
   * because the row's purpose is to record that this lender does this
   * product and a blank name would hide that rather than admit it. */
  name?: string;
  minAmount?: number;
  maxAmount?: number;
  indicativeRate?: number;
  notes?: string;
}

export function addSupportedProduct(input: SupportedProductInput, actorUserId: Id): ActionResult {
  const organisation = db.organisations.find((org) => org.id === input.organisationId);
  if (!organisation) return { ok: false, message: "That lender no longer exists." };
  const product = db.loanProducts.find((p) => p.id === input.loanProductId);
  if (!product) return { ok: false, message: "That lending product no longer exists." };
  if (
    db.bankProducts.some(
      (bp) =>
        bp.organisationId === input.organisationId &&
        bp.loanProductId === input.loanProductId &&
        bp.isActive,
    )
  ) {
    return { ok: false, message: `${organisation.canonicalName} already offers this product.` };
  }
  const { minAmount, maxAmount } = input;
  if (minAmount !== undefined && maxAmount !== undefined && maxAmount < minAmount) {
    return { ok: false, message: "Maximum amount cannot be less than the minimum." };
  }

  const entry: BankProduct = {
    id: nextId(),
    organisationId: input.organisationId,
    loanProductId: input.loanProductId,
    name: trimmed(input.name) ?? product.name ?? product.variant,
    isActive: true,
    displayOrder: product.displayOrder,
    ...(minAmount !== undefined ? { minAmount } : {}),
    ...(maxAmount !== undefined ? { maxAmount } : {}),
    ...(input.indicativeRate !== undefined ? { indicativeRate: input.indicativeRate } : {}),
    ...(trimmed(input.notes) ? { notes: trimmed(input.notes) as string } : {}),
  };

  db = { ...db, bankProducts: [...db.bankProducts, entry] };

  record({
    actorUserId,
    entityType: "bank_product",
    entityId: entry.id,
    eventType: "master_data.created",
    summary: `${organisation.canonicalName} offers ${entry.name}`,
  });
  commit();
  return { ok: true };
}

export function setSupportedProductActive(
  bankProductId: Id,
  isActive: boolean,
  actorUserId: Id,
): ActionResult {
  const existing = db.bankProducts.find((bp) => bp.id === bankProductId);
  if (!existing) return { ok: false, message: "Product not found." };

  db = {
    ...db,
    bankProducts: db.bankProducts.map((bp) => (bp.id === bankProductId ? { ...bp, isActive } : bp)),
  };

  record({
    actorUserId,
    entityType: "bank_product",
    entityId: bankProductId,
    eventType: isActive ? "master_data.activated" : "master_data.deactivated",
    summary: `Supported product ${isActive ? "restored" : "withdrawn"}: ${existing.name}`,
  });
  commit();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Submission rules â€” reference material. Nothing executes one.
// ---------------------------------------------------------------------------

export interface SubmissionRuleInput {
  organisationId: Id;
  loanProductId?: Id;
  submissionModeId?: Id;
  portalUrl?: string;
  whatToCarry?: string;
  loginFeeNotes?: string;
  turnaroundNotes?: string;
  notes?: string;
}

function submissionRuleFields(input: SubmissionRuleInput): Partial<LenderSubmissionRule> {
  return {
    ...(input.loanProductId ? { loanProductId: input.loanProductId } : {}),
    ...(input.submissionModeId ? { submissionModeId: input.submissionModeId } : {}),
    ...(trimmed(input.portalUrl) ? { portalUrl: trimmed(input.portalUrl) as string } : {}),
    ...(trimmed(input.whatToCarry) ? { whatToCarry: trimmed(input.whatToCarry) as string } : {}),
    ...(trimmed(input.loginFeeNotes) ? { loginFeeNotes: trimmed(input.loginFeeNotes) as string } : {}),
    ...(trimmed(input.turnaroundNotes)
      ? { turnaroundNotes: trimmed(input.turnaroundNotes) as string }
      : {}),
    ...(trimmed(input.notes) ? { notes: trimmed(input.notes) as string } : {}),
  };
}

export function createSubmissionRule(input: SubmissionRuleInput, actorUserId: Id): ActionResult {
  const organisation = db.organisations.find((org) => org.id === input.organisationId);
  if (!organisation) return { ok: false, message: "That lender no longer exists." };

  const rule: LenderSubmissionRule = {
    id: nextId(),
    organisationId: input.organisationId,
    isActive: true,
    displayOrder: (db.lenderSubmissionRules.length + 1) * 10,
    ...submissionRuleFields(input),
  };
  db = { ...db, lenderSubmissionRules: [...db.lenderSubmissionRules, rule] };

  record({
    actorUserId,
    entityType: "lender_submission_rule",
    entityId: rule.id,
    eventType: "master_data.created",
    summary: `Submission note added for ${organisation.canonicalName}`,
  });
  commit();
  return { ok: true };
}

export function updateSubmissionRule(
  ruleId: Id,
  input: SubmissionRuleInput,
  actorUserId: Id,
): ActionResult {
  const existing = db.lenderSubmissionRules.find((rule) => rule.id === ruleId);
  if (!existing) return { ok: false, message: "Submission note not found." };

  db = {
    ...db,
    lenderSubmissionRules: db.lenderSubmissionRules.map((rule) =>
      rule.id === ruleId
        ? {
            id: rule.id,
            organisationId: input.organisationId,
            isActive: rule.isActive,
            displayOrder: rule.displayOrder,
            ...submissionRuleFields(input),
          }
        : rule,
    ),
  };

  record({
    actorUserId,
    entityType: "lender_submission_rule",
    entityId: ruleId,
    eventType: "master_data.updated",
    summary: "Submission note updated",
  });
  commit();
  return { ok: true };
}

export function setSubmissionRuleActive(
  ruleId: Id,
  isActive: boolean,
  actorUserId: Id,
): ActionResult {
  const existing = db.lenderSubmissionRules.find((rule) => rule.id === ruleId);
  if (!existing) return { ok: false, message: "Submission note not found." };

  db = {
    ...db,
    lenderSubmissionRules: db.lenderSubmissionRules.map((rule) =>
      rule.id === ruleId ? { ...rule, isActive } : rule,
    ),
  };

  record({
    actorUserId,
    entityType: "lender_submission_rule",
    entityId: ruleId,
    eventType: isActive ? "master_data.activated" : "master_data.deactivated",
    summary: `Submission note ${isActive ? "restored" : "removed"}`,
  });
  commit();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The lender profile â€” institutional knowledge.
//
// GUIDANCE, NEVER A RULE. `body` is stored, shown, and never parsed. Nothing
// in this store, this prototype or the domain layer branches on its content,
// and nothing may (ADR-034).
// ---------------------------------------------------------------------------

export interface LenderInsightInput {
  organisationId: Id;
  lenderInsightCategoryId: Id;
  body: string;
  loanProductId?: Id;
  observedOn?: string;
}

export function addLenderInsight(input: LenderInsightInput, actorUserId: Id): ActionResult {
  const organisation = db.organisations.find((org) => org.id === input.organisationId);
  if (!organisation) return { ok: false, message: "That lender no longer exists." };
  if (!input.body.trim()) return { ok: false, message: "Write the note before saving it." };
  if (!input.lenderInsightCategoryId) {
    return { ok: false, message: "Choose what kind of note this is." };
  }

  const insight: LenderInsight = {
    id: nextId(),
    organisationId: input.organisationId,
    lenderInsightCategoryId: input.lenderInsightCategoryId,
    body: input.body.trim(),
    isActive: true,
    displayOrder: (db.lenderInsights.length + 1) * 10,
    ...(input.loanProductId ? { loanProductId: input.loanProductId } : {}),
    ...(input.observedOn ? { observedOn: input.observedOn } : {}),
  };
  db = { ...db, lenderInsights: [...db.lenderInsights, insight] };

  record({
    actorUserId,
    entityType: "lender_insight",
    entityId: insight.id,
    eventType: "master_data.created",
    summary: `Note added about ${organisation.canonicalName}`,
  });
  commit();
  return { ok: true };
}

export function setLenderInsightActive(
  insightId: Id,
  isActive: boolean,
  actorUserId: Id,
): ActionResult {
  const existing = db.lenderInsights.find((insight) => insight.id === insightId);
  if (!existing) return { ok: false, message: "Note not found." };

  db = {
    ...db,
    lenderInsights: db.lenderInsights.map((insight) =>
      insight.id === insightId ? { ...insight, isActive } : insight,
    ),
  };

  record({
    actorUserId,
    entityType: "lender_insight",
    entityId: insightId,
    eventType: isActive ? "master_data.activated" : "master_data.deactivated",
    summary: `Note ${isActive ? "restored" : "retired"}`,
  });
  commit();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Derived reads â€” the same translation the server will do when it loads a
// lender out of Postgres, done here so the catalogue screen filters through
// the real domain code rather than through a second implementation of it.
// ---------------------------------------------------------------------------

export interface LenderCatalogueView {
  institutions: LenderInstitution[];
  branches: LenderBranch[];
  supportedProducts: DomainSupportedProduct[];
  insights: DomainLenderInsight[];
  submissionRules: DomainSubmissionRule[];
}

/**
 * Projects the stored lender catalogue into the domain layer's shape â€” ids
 * resolved to codes, which is what @domain/lenders reasons about.
 *
 * Branches, and anything hanging off one, have no code of their own, so their
 * id stands in as their code. Deliberate and safe: the domain layer only
 * compares these values with each other, never with a code anybody typed.
 */
export function lendersAsDomain(source: Database = db): LenderCatalogueView {
  const profileCode = (organisationId: Id): string | undefined =>
    source.lenderProfiles.find((profile) => profile.organisationId === organisationId)?.code;
  const masterCode = (list: readonly MasterDataRecord[], id?: Id): string | undefined =>
    id === undefined ? undefined : list.find((record) => record.id === id)?.code;
  const productCode = (id?: Id): string | undefined =>
    id === undefined ? undefined : source.loanProducts.find((p) => p.id === id)?.code;
  /** An institution's code, or a branch's id â€” whichever this row hangs off. */
  const organisationKey = (organisationId: Id): string =>
    profileCode(organisationId) ?? organisationId;

  const institutions: LenderInstitution[] = source.lenderProfiles.flatMap((profile) => {
    const organisation = source.organisations.find((org) => org.id === profile.organisationId);
    if (!organisation || profile.code === undefined) return [];
    return [
      {
        code: profile.code,
        name: organisation.canonicalName,
        lenderTypeCode: masterCode(source.lenderTypes, profile.lenderTypeId),
        headOfficeCity: profile.headOfficeCity,
        primaryServiceRegion: profile.primaryServiceRegion,
        websiteUrl: profile.websiteUrl,
        isOnPanel: profile.isOnPanel,
        // `isActive` is optional on Organisation and absent means active,
        // matching the column's default in the schema.
        isActive: organisation.isActive !== false,
        typicalTurnaroundDays: profile.typicalTurnaroundDays,
        preferredCustomerSegments: profile.preferredCustomerSegments,
        knownStrengths: profile.knownStrengths,
        knownLimitations: profile.knownLimitations,
        commonRejectionPatterns: profile.commonRejectionPatterns,
        internalRemarks: profile.internalRemarks,
        notes: profile.notes,
        aliases: organisation.aliases,
      },
    ];
  });

  const branches: LenderBranch[] = source.bankBranches.flatMap((branch) => {
    const organisation = source.organisations.find((org) => org.id === branch.organisationId);
    if (!organisation?.parentOrganisationId) return [];
    const institutionCode = profileCode(organisation.parentOrganisationId);
    if (institutionCode === undefined) return [];
    return [
      {
        id: branch.organisationId,
        institutionCode,
        name: organisation.canonicalName,
        cityCode: masterCode(source.cities, branch.cityId),
        districtCode: masterCode(source.districts, branch.districtId),
        addressLine: branch.addressLine,
        contactNumber: branch.contactNumber,
        email: branch.email,
        status: branch.operationalStatus,
        isActive: organisation.isActive !== false,
        notes: branch.notes,
      },
    ];
  });

  const supportedProducts: DomainSupportedProduct[] = source.bankProducts.flatMap((entry) => {
    const code = productCode(entry.loanProductId);
    if (code === undefined) return [];
    return [
      {
        id: entry.id,
        organisationCode: organisationKey(entry.organisationId),
        lendingProductCode: code,
        name: entry.name,
        minAmount: entry.minAmount,
        maxAmount: entry.maxAmount,
        indicativeRate: entry.indicativeRate,
        notes: entry.notes,
        isActive: entry.isActive,
      },
    ];
  });

  const insights: DomainLenderInsight[] = source.lenderInsights.flatMap((insight) => {
    const category = masterCode(source.lenderInsightCategories, insight.lenderInsightCategoryId);
    if (category === undefined) return [];
    return [
      {
        id: insight.id,
        organisationCode: organisationKey(insight.organisationId),
        categoryCode: category,
        body: insight.body,
        lendingProductCode: productCode(insight.loanProductId),
        observedOn: insight.observedOn,
        isActive: insight.isActive,
      },
    ];
  });

  const submissionRules: DomainSubmissionRule[] = source.lenderSubmissionRules.map((rule) => ({
    id: rule.id,
    organisationCode: organisationKey(rule.organisationId),
    lendingProductCode: productCode(rule.loanProductId),
    submissionModeCode: masterCode(source.submissionModes, rule.submissionModeId),
    portalUrl: rule.portalUrl,
    whatToCarry: rule.whatToCarry,
    loginFeeNotes: rule.loginFeeNotes,
    turnaroundNotes: rule.turnaroundNotes,
    notes: rule.notes,
    isActive: rule.isActive,
  }));

  return { institutions, branches, supportedProducts, insights, submissionRules };
}

