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
import type {
  AosEvent,
  CasePartyRole,
  Database,
  Id,
  LoanCase,
  MasterDataRecord,
  SubmissionStatus,
} from "./types.js";

const STORAGE_KEY = "aos.prototype.v1";

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
  "loanCategories",
  "employmentTypes",
  "businessConstitutions",
  "propertyTypes",
  "propertyOwnershipTypes",
  "referralSources",
  "districts",
  "cities",
] as const;

export type MasterDataKind = (typeof MASTER_DATA_KINDS)[number];

export const MASTER_DATA_LABELS: Record<MasterDataKind, string> = {
  loanCategories: "Loan Category",
  employmentTypes: "Employment Type",
  businessConstitutions: "Business Constitution",
  propertyTypes: "Property Type",
  propertyOwnershipTypes: "Property Ownership Type",
  referralSources: "Referral Source",
  districts: "District",
  cities: "City",
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
      const { description, notes, effectiveFrom, districtId, ...rest } = r;
      return {
        ...rest,
        ...(description !== undefined ? { description } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(effectiveFrom !== undefined ? { effectiveFrom } : {}),
        ...(districtId !== undefined ? { districtId } : {}),
        ...(name ? { name } : {}),
        ...(patch.displayOrder !== undefined ? { displayOrder: patch.displayOrder } : {}),
        ...(patch.description?.trim() ? { description: patch.description.trim() } : {}),
        ...(patch.effectiveFrom ? { effectiveFrom: patch.effectiveFrom } : {}),
        ...(patch.notes?.trim() ? { notes: patch.notes.trim() } : {}),
        ...(kind === "cities" && patch.districtId ? { districtId: patch.districtId } : {}),
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
