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
  type ProgressionStage,
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
  CUSTOM_DOCUMENT_TYPE_CODE,
  type DocumentCategory,
} from "@domain/requirements/document-catalogue.js";
import type { ConstructionStage } from "@domain/requirements/rules.js";
import {
  buildStoragePath,
  nextVersion,
  resolveDocumentOwner,
} from "@domain/storage/index.js";

import { hasPermission, type Role, type Scope } from "@domain/permissions/index.js";

import { applyExistingDocuments, regenerateRequirements } from "./requirements.js";
import { getStorageConfig, objectExists, storageAdapter } from "./storage.js";
import { buildSeed } from "./seed.js";
import type { ApplicabilityCode, LendingProduct } from "@domain/products/index.js";
import type {
  LenderBranch,
  LenderInsight as DomainLenderInsight,
  LenderInstitution,
  SubmissionRule as DomainSubmissionRule,
  SupportedProduct as DomainSupportedProduct,
} from "@domain/lenders/index.js";
import {
  describeCounterparty,
  describeProblem,
  describeRecipientCount,
  isEmailShaped,
  validateRecipients,
  type RecipientDraft,
} from "@domain/submissions/index.js";

import type {
  AosEvent,
  AvailabilityStatus,
  BankBranch,
  BankContact,
  BankProduct,
  BranchStatus,
  CasePartyRole,
  Database,
  DocumentRequirementRule,
  Id,
  LenderInsight,
  LenderProfile,
  LenderSubmissionRule,
  LoanCase,
  LoanProduct,
  MasterDataRecord,
  Organisation,
  Person,
  PersonIdentifier,
  Submission,
  SubmissionRecipient,
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
 *
 * v4 for the Document Requirement Engine (Milestone 9). A stale v3 store has
 * no `documentRequirementRules` at all, which would generate ZERO
 * requirements on every case — a checklist that is empty rather than obviously
 * broken, which is the worst way for stale data to fail.
 *
 * v5 for the identity fix below. A store written by v4 can contain DUPLICATE
 * row ids — that is the bug, not a shape change — and there is no honest way
 * to repair one: once two cases share an id, which of them the user meant is
 * unrecoverable. Discarding it is the only outcome that cannot silently show
 * somebody the wrong case.
 *
 * v6 for the Bank Submission Workflow (Milestone 10). A stale v5 store has no
 * `submissionRecipients` collection at all, and its lenders still carry the
 * single placeholder "— Coimbatore" branch rather than the localities a file
 * is actually lodged at. Adding a bank would fail on a missing array, which
 * is the kind of failure that reads as a broken feature rather than as stale
 * data.
 *
 * v7 for the Telecaller Workflow refinement (Milestone 11, commit 917c7c5),
 * which this bump should have shipped with and did not. That milestone added
 * `other_document` to the catalogue as the anchor every hand-added custom
 * requirement points at (see `CUSTOM_DOCUMENT_TYPE_CODE` in
 * document-catalogue.ts) and the `isCustom`/`customName` fields on
 * `Requirement`. A stale v6 store predates that row entirely, so the first
 * time anyone on it used "Existing Loans and EMIs" → "+ Another loan" (or any
 * other hand-added document), `addCustomRequirement` looked up a document
 * type that simply was not in that store and failed with "The 'Other
 * Document' type is missing from master data." — reported as a bug in the
 * loan-statement flow, but really this same missed bump.
 */
const STORAGE_KEY = "aos.prototype.v7";

/**
 * Row identity.
 *
 * WHY THIS IS NOT A COUNTER ANY MORE — the root cause of the P0 "creating a
 * new case opens an existing case" bug.
 *
 * The previous implementation was `let counter = 1000; () => \`gen_${++counter}\``.
 * `counter` lives in MODULE scope and is re-initialised to 1000 on every page
 * load. `db` does not: it is persisted to localStorage and survives the
 * reload. So the second time anyone opened the prototype, `nextId()` began
 * handing back `gen_1001`, `gen_1002`, … — ids the previous session had
 * already assigned to real rows.
 *
 * `createCase` then appended a second case carrying an id an older case
 * already had, and every read in this file is a `find()`, which returns the
 * FIRST match. `navigate('/cases/' + caseId)` was therefore correct and still
 * opened the older case — with the older case's stage, which is exactly how
 * the bug was reported ("opens an existing case with an incorrect status").
 * Refreshing could not help: the URL was right and the lookup was wrong.
 *
 * Persisting the counter would close this instance and leave the class of bug
 * open (two tabs, a failed write, a restored backup). Identity is generated
 * instead — which is what the real schema uses for a primary key anyway
 * (ADR-024: the case's identity is its UUID; the case NUMBER is the human
 * handle, and that one is still allocated from a sequence, correctly, because
 * `caseNumberSequence` lives in `db` and is persisted with it).
 */
let fallbackCounter = 0;

const nextId = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) {
    return `gen_${uuid}`;
  }
  // No Web Crypto — an older browser, or a bare test runner. Wall clock plus
  // randomness plus a monotonic tail is unique across reloads without relying
  // on anything surviving one, which is the property that failed above.
  fallbackCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `gen_${Date.now().toString(36)}${fallbackCounter.toString(36)}${random}`;
};

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
  // Every mutator in this file writes through `db.cases = db.cases.map(...)` and
  // friends — reassigning a property, never `db` itself. `useDatabase()` hands
  // `getDb` to React's `useSyncExternalStore` as `getSnapshot`, and React decides
  // whether to re-render a given subscriber by `Object.is`-comparing the snapshot
  // it got last time against what `getSnapshot` returns now. Since `db` was never
  // reassigned, that comparison always saw the same reference and always said
  // "unchanged" — so a component only actually re-rendered when something else
  // (a local `useState` change, a parent remounting) happened to force it anyway,
  // which is why some parts of a page updated immediately and others (a sibling
  // card with no such coincidental trigger) went stale for an unpredictable
  // stretch, or indefinitely. `resetDatabase` never had this problem because it
  // assigns `db = bootstrap()`, a genuinely new reference — that's the tell.
  // Cloning here on every commit gives every commit that same property, so every
  // subscriber sees a changed snapshot and React is required to re-render it.
  db = { ...db };
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
// Authorization — every mutation checks who is asking, not just the UI
// (real-world-issues milestone, Part 7)
//
// Before this, `actorUserId` was threaded through every mutation here and
// used for exactly one thing: whose name goes on the event. Nothing checked
// whether that actor was ALLOWED to do what they were doing — a telecaller
// could call `createSubmission` directly, at the store layer, despite having
// no `submission.create` grant at any scope, because the only thing standing
// between them and a bank submission was a hidden button.
//
// The helpers below close that gap by reusing `hasPermission` from
// `@domain/permissions` — the SAME function `session.can()` wraps for the UI,
// and the same one the server's `app.has_permission()` is seeded from — so
// there is one definition of "is this allowed", not a second one that could
// quietly disagree.
//
// WHAT THIS DOES NOT DO. `db` is a plain in-memory object and `getDb()`
// hands the whole thing to any component that asks — there is no row-level
// READ filtering here, and there cannot be without a real backend boundary,
// which is out of scope for this prototype. What follows makes every WRITE
// check permission and ownership before it takes effect, which is what
// "reject a telecaller sending a case to a bank" actually requires. It does
// not make another user's case invisible to a determined reader of browser
// state — that is a known, stated limitation, not something silently
// declared solved.
// ---------------------------------------------------------------------------

function actorRoles(actorUserId: Id): readonly Role[] {
  return db.users.find((u) => u.id === actorUserId)?.roles ?? [];
}

/**
 * Refuse the action unless `actorUserId` holds `permission` at least at
 * `scope`. Returns the refusal to return straight from the caller, or
 * `undefined` when the actor may proceed — so a guard reads as
 * `const refusal = authorize(...); if (refusal) return refusal;`.
 */
function authorize(
  actorUserId: Id,
  permission: string,
  scope: Scope = "all",
): ActionResult | undefined {
  if (hasPermission(actorRoles(actorUserId), permission, scope)) {
    return undefined;
  }
  return { ok: false, message: `You do not have permission to do that (${permission}).` };
}

/**
 * Whether `actorUserId` may act on `loanCase` for `permission` — holding it
 * at `all` scope, or at `own` scope while actually owning the case.
 *
 * The exact OR the UI already computes inline in several places
 * (`session.can(x, "all") || (session.can(x, "own") && loanCase.ownerUserId
 * === session.user.id)`, e.g. `CaseDetail.tsx`'s `canEdit`/`mayRead`).
 * Exported so the store's own guards below and the UI can eventually share
 * one implementation instead of two that could drift apart — the UI's
 * existing inline checks are not refactored to call this in this milestone,
 * but any new call site should.
 */
export function canActOnCase(actorUserId: Id, loanCase: LoanCase, permission: string): boolean {
  const roles = actorRoles(actorUserId);
  return (
    hasPermission(roles, permission, "all") ||
    (hasPermission(roles, permission, "own") && loanCase.ownerUserId === actorUserId)
  );
}

/** `canActOnCase`, as a refusal-or-undefined guard for a mutation to return early on. */
function authorizeOnCase(
  actorUserId: Id,
  loanCase: LoanCase,
  permission: string,
): ActionResult | undefined {
  if (canActOnCase(actorUserId, loanCase, permission)) {
    return undefined;
  }
  return { ok: false, message: `You do not have permission to do that (${permission}).` };
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
      // Optional requirements are shown and collected like any other but
      // never counted against the case (Milestone 9) — an optional document
      // nobody chased must not hold a complete file at 94%.
      ...(r.applicability ? { applicability: r.applicability } : {}),
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

  // Is this actor allowed to move THIS case at all — separate from whether
  // the move itself is legal, which evaluateTransition below decides
  // (real-world-issues milestone, Part 7). autoAdvance and
  // reconcileReadiness mutate db.cases directly rather than calling this
  // function, so system-driven transitions are never subject to this check.
  const refusal = authorizeOnCase(actorUserId, loanCase, "case.update");
  if (refusal) return refusal;

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
  // The invariant the P0 bug violated, asserted rather than assumed. If
  // identity generation ever regresses, this fails loudly at the point of
  // creation instead of silently navigating the user into somebody else's
  // case — which is the failure mode that made the original bug so hard to
  // see, because nothing anywhere reported that anything had gone wrong.
  if (db.cases.some((existing) => existing.id === caseId)) {
    throw new Error(
      `Case id collision on ${caseId}. Row identity is not unique — see nextId() in fake/store.ts.`,
    );
  }

  const loanCase: LoanCase = {
    id: caseId,
    caseNumber: formatCaseNumber({ year, sequence }),
    loanProductId: input.loanProductId,
    ...(input.requestedAmount ? { requestedAmount: input.requestedAmount } : {}),
    stage: "new",
    ownerUserId: actorUserId,
    // Who brought this case in, set once and never touched again — distinct
    // from ownerUserId, which assignOwner changes as the case moves through
    // Login (real-world-issues milestone, Part 4).
    createdByUserId: actorUserId,
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

/**
 * Change who currently holds the case — not who brought it in
 * (`createdByUserId`, set once at creation and never touched here).
 *
 * This is how "who processed it in Login" becomes answerable at all: the
 * single-owner model (BR-011) keeps exactly one accountable holder at a time
 * rather than a list of processors, and the sequence of who held a case and
 * when is reconstructed from `case.assigned` events like this one, in order
 * (real-world-issues milestone, Part 4).
 */
export function assignOwner(caseId: Id, ownerUserId: Id, actorUserId: Id): ActionResult {
  const refusal = authorize(actorUserId, "case.assign", "all");
  if (refusal) return refusal;

  const loanCase = db.cases.find((c) => c.id === caseId);
  if (!loanCase) return { ok: false, message: "Case not found." };

  const to = db.users.find((u) => u.id === ownerUserId);
  if (!to) return { ok: false, message: "That user does not exist." };
  if (loanCase.ownerUserId === ownerUserId) return { ok: true };

  db.cases = db.cases.map((c) => (c.id === caseId ? { ...c, ownerUserId } : c));
  record({
    actorUserId,
    caseId,
    entityType: "case",
    entityId: caseId,
    eventType: "case.assigned",
    summary: `Owner changed to ${to.name}`,
  });
  commit();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Case facts — the inputs the Document Requirement Engine reads (Milestone 9)
//
// Every mutation here ends in `regenerate`, which is the milestone's UI
// promise: the Documents page updates the moment a fact changes, with no
// refresh and no "recalculate" button. A checklist a user has to remember to
// refresh is a checklist that is wrong most of the time.
// ---------------------------------------------------------------------------

export interface CaseFactsInput {
  isGstRegistered?: boolean | undefined;
  constructionStage?: ConstructionStage | undefined;
  hasExistingObligations?: boolean | undefined;
  /**
   * The amount asked for. A rule may condition on it (`case.requested_amount`
   * with gte / lte), and until the Telecaller Workflow milestone it was
   * displayed in the case header with no way to change it — a number the user
   * could read and not correct.
   */
  requestedAmount?: number | undefined;
}

/**
 * Record a case fact. Each is three-valued — undefined means "nobody has
 * asked yet", which is not false, and clearing an answer back to unknown is a
 * legitimate thing to do.
 */
export function updateCaseFacts(
  caseId: Id,
  input: CaseFactsInput,
  actorUserId: Id,
): ActionResult {
  const loanCase = db.cases.find((c) => c.id === caseId);
  if (!loanCase) return { ok: false, message: "Case not found." };

  const changes: string[] = [];
  const describe = (label: string, before: unknown, after: unknown): void => {
    if (before === after) return;
    changes.push(`${label}: ${format(before)} → ${format(after)}`);
  };
  const format = (value: unknown): string =>
    value === undefined ? "not asked" : value === true ? "yes" : value === false ? "no" : String(value);

  describe("GST registered", loanCase.isGstRegistered, input.isGstRegistered);
  describe("Construction stage", loanCase.constructionStage, input.constructionStage);
  describe("Existing obligations", loanCase.hasExistingObligations, input.hasExistingObligations);
  describe("Requested amount", loanCase.requestedAmount, input.requestedAmount);

  if (changes.length === 0) return { ok: true };

  db.cases = db.cases.map((c) => {
    if (c.id !== caseId) return c;
    const { isGstRegistered, constructionStage, hasExistingObligations, requestedAmount, ...rest } =
      c;
    return {
      ...rest,
      ...(input.isGstRegistered !== undefined ? { isGstRegistered: input.isGstRegistered } : {}),
      ...(input.constructionStage ? { constructionStage: input.constructionStage } : {}),
      ...(input.hasExistingObligations !== undefined
        ? { hasExistingObligations: input.hasExistingObligations }
        : {}),
      ...(input.requestedAmount !== undefined ? { requestedAmount: input.requestedAmount } : {}),
    };
  });

  const before = progressFor(caseId).percentComplete;
  regenerate(caseId, changes.join("; "));
  const after = progressFor(caseId).percentComplete;

  record({
    actorUserId,
    caseId,
    entityType: "case",
    entityId: caseId,
    eventType: "case.facts_updated",
    // Progress moving backwards because a fact was recorded honestly is the
    // system working, not a regression to hide.
    summary:
      after === before
        ? changes.join("; ")
        : `${changes.join("; ")} — progress ${before}% → ${after}%`,
  });

  reconcileReadiness(caseId, "Case facts updated");
  commit();
  return { ok: true };
}

/**
 * Change the lending product mid-case.
 *
 * The requirements of the old product are not deleted — they become
 * `not_applicable` and leave the arithmetic (BR-034), because a document that
 * was collected under the old product is part of what happened to this case.
 */
export function changeLoanProduct(
  caseId: Id,
  loanProductId: Id,
  actorUserId: Id,
): ActionResult {
  const loanCase = db.cases.find((c) => c.id === caseId);
  if (!loanCase) return { ok: false, message: "Case not found." };
  if (loanCase.loanProductId === loanProductId) return { ok: true };

  const from = db.loanProducts.find((p) => p.id === loanCase.loanProductId);
  const to = db.loanProducts.find((p) => p.id === loanProductId);
  if (!to) return { ok: false, message: "That lending product does not exist." };

  db.cases = db.cases.map((c) => (c.id === caseId ? { ...c, loanProductId } : c));

  const before = progressFor(caseId).percentComplete;
  regenerate(caseId, "Loan product changed");
  const after = progressFor(caseId).percentComplete;

  record({
    actorUserId,
    caseId,
    entityType: "case",
    entityId: caseId,
    eventType: "case.product_changed",
    summary: `Lending product changed: ${from?.name ?? from?.variant ?? "unknown"} → ${to.name ?? to.variant} — progress ${before}% → ${after}%`,
  });

  reconcileReadiness(caseId, "Loan product changed");
  commit();
  return { ok: true };
}

export interface CasePropertyInput {
  propertyId?: Id;
  role: "collateral" | "purchase" | "both";
  /** Search found nothing: create the property inline, same as a person. */
  newPropertyLocality?: string;
  newPropertyCity?: string;
  newPropertyTypeId?: Id;
}

/**
 * Attach a property to the case — the fact behind every property rule.
 *
 * Before this existed, seeded cases had properties and new ones never could,
 * which made "property documents only when collateral exists" untestable in
 * the running prototype.
 */
export function addCaseProperty(
  caseId: Id,
  input: CasePropertyInput,
  actorUserId: Id,
): ActionResult {
  let propertyId = input.propertyId;

  if (!propertyId) {
    const locality = input.newPropertyLocality?.trim();
    if (!locality) {
      return { ok: false, message: "A property needs at least a locality to be findable later." };
    }
    propertyId = nextId();
    const propertyType = db.propertyTypes.find((t) => t.id === input.newPropertyTypeId);
    db.properties = [
      ...db.properties,
      {
        id: propertyId,
        locality,
        ...(input.newPropertyCity?.trim() ? { city: input.newPropertyCity.trim() } : {}),
        ...(propertyType
          ? { propertyTypeId: propertyType.id, propertyType: propertyType.name }
          : {}),
      },
    ];
    record({
      actorUserId,
      entityType: "property",
      entityId: propertyId,
      eventType: "property.created",
      summary: `Property created: ${locality}`,
    });
  }

  if (db.caseProperties.some((p) => p.caseId === caseId && p.propertyId === propertyId)) {
    return { ok: false, message: "That property is already on this case." };
  }

  db.caseProperties = [
    ...db.caseProperties,
    { id: nextId(), caseId, propertyId, role: input.role },
  ];

  const property = db.properties.find((p) => p.id === propertyId);
  const before = progressFor(caseId).percentComplete;
  regenerate(caseId, "Property added");
  const after = progressFor(caseId).percentComplete;

  record({
    actorUserId,
    caseId,
    entityType: "case_property",
    eventType: "case.property_added",
    summary: `Property added: ${property?.locality ?? "property"} — progress ${before}% → ${after}%`,
  });

  reconcileReadiness(caseId, "Property added");
  commit();
  return { ok: true };
}

export interface CasePropertyEditInput {
  role?: "collateral" | "purchase" | "both";
  propertyTypeId?: Id;
  locality?: string;
  city?: string;
}

/**
 * Correct a property already on the case.
 *
 * The property type is the fact behind two live rules — an apartment on
 * undivided share has no patta of its own, and layout approval is asked for
 * on plots — so "I picked the wrong type" had to be fixable without deleting
 * the property and losing every document already collected against it.
 */
export function updateCaseProperty(
  casePropertyId: Id,
  input: CasePropertyEditInput,
  actorUserId: Id,
): ActionResult {
  const link = db.caseProperties.find((p) => p.id === casePropertyId);
  if (!link) return { ok: false, message: "That property is not on this case." };

  const property = db.properties.find((p) => p.id === link.propertyId);
  if (!property) return { ok: false, message: "Property record not found." };

  const changes: string[] = [];
  if (input.role && input.role !== link.role) {
    changes.push(`role: ${link.role} → ${input.role}`);
    db.caseProperties = db.caseProperties.map((p) =>
      p.id === casePropertyId ? { ...p, role: input.role as typeof p.role } : p,
    );
  }

  const nextType = db.propertyTypes.find((t) => t.id === input.propertyTypeId);
  const locality = input.locality?.trim();
  const city = input.city?.trim();

  if (
    (nextType && nextType.id !== property.propertyTypeId) ||
    (locality && locality !== property.locality) ||
    (city && city !== property.city)
  ) {
    if (nextType && nextType.id !== property.propertyTypeId) {
      changes.push(`type: ${property.propertyType ?? "not set"} → ${nextType.name}`);
    }
    if (locality && locality !== property.locality) changes.push(`locality: ${locality}`);
    if (city && city !== property.city) changes.push(`city: ${city}`);

    db.properties = db.properties.map((p) =>
      p.id !== property.id
        ? p
        : {
            ...p,
            ...(locality ? { locality } : {}),
            ...(city ? { city } : {}),
            ...(nextType ? { propertyTypeId: nextType.id, propertyType: nextType.name } : {}),
          },
    );
  }

  if (changes.length === 0) return { ok: true };

  const before = progressFor(link.caseId).percentComplete;
  regenerate(link.caseId, "Property updated");
  const after = progressFor(link.caseId).percentComplete;

  record({
    actorUserId,
    caseId: link.caseId,
    entityType: "case_property",
    entityId: casePropertyId,
    eventType: "case.property_updated",
    summary: `Property updated: ${changes.join("; ")} — progress ${before}% → ${after}%`,
  });

  reconcileReadiness(link.caseId, "Property updated");
  commit();
  return { ok: true };
}

/**
 * Take a property off the case.
 *
 * The property record itself survives — it may be on another case, and a
 * shared entity is never deleted from a case screen. What goes is the LINK,
 * and with it every property requirement: absence is silence (ADR-010), so
 * they become `not_applicable` through the ordinary regeneration path rather
 * than being deleted, and any document already collected stays reachable in
 * the case's history.
 */
export function removeCaseProperty(casePropertyId: Id, actorUserId: Id): ActionResult {
  const link = db.caseProperties.find((p) => p.id === casePropertyId);
  if (!link) return { ok: false, message: "That property is not on this case." };

  const property = db.properties.find((p) => p.id === link.propertyId);
  db.caseProperties = db.caseProperties.filter((p) => p.id !== casePropertyId);

  const before = progressFor(link.caseId).percentComplete;
  regenerate(link.caseId, "Property removed");
  const after = progressFor(link.caseId).percentComplete;

  record({
    actorUserId,
    caseId: link.caseId,
    entityType: "case_property",
    entityId: casePropertyId,
    eventType: "case.property_removed",
    summary: `Property removed: ${property?.locality ?? "property"} — its documents are no longer applicable — progress ${before}% → ${after}%`,
  });

  reconcileReadiness(link.caseId, "Property removed");
  commit();
  return { ok: true };
}

export interface PartyProfileInput {
  employmentTypeId?: Id | undefined;
  borrowerTypeId?: Id | undefined;
  businessConstitutionId?: Id | undefined;
}

/**
 * Record how a party is being underwritten ON THIS CASE.
 *
 * Deliberately NOT an edit of the person's employment record or the
 * organisation's constitution. A case screen that rewrites a shared entity to
 * change one case's checklist corrupts every other case that person is on —
 * and "underwritten as salaried here, as a business owner there" is two
 * facts, not one fact that keeps changing (Database/migrations/0021).
 */
export function updatePartyProfile(
  casePartyId: Id,
  input: PartyProfileInput,
  actorUserId: Id,
): ActionResult {
  const party = db.caseParties.find((p) => p.id === casePartyId);
  if (!party) return { ok: false, message: "That party is not on this case." };

  db.caseParties = db.caseParties.map((p) => {
    if (p.id !== casePartyId) return p;
    const { employmentTypeId, borrowerTypeId, businessConstitutionId, ...rest } = p;
    return {
      ...rest,
      ...(input.employmentTypeId ? { employmentTypeId: input.employmentTypeId } : {}),
      ...(input.borrowerTypeId ? { borrowerTypeId: input.borrowerTypeId } : {}),
      ...(input.businessConstitutionId
        ? { businessConstitutionId: input.businessConstitutionId }
        : {}),
    };
  });

  const person = db.people.find((p) => p.id === party.personId);
  const organisation = db.organisations.find((o) => o.id === party.organisationId);
  const name = person?.fullName ?? organisation?.canonicalName ?? "Party";

  const before = progressFor(party.caseId).percentComplete;
  regenerate(party.caseId, "Party profile updated");
  const after = progressFor(party.caseId).percentComplete;

  record({
    actorUserId,
    caseId: party.caseId,
    entityType: "case_party",
    entityId: casePartyId,
    eventType: "case.party_profile_updated",
    summary: `${name}'s profile updated — progress ${before}% → ${after}%`,
  });

  reconcileReadiness(party.caseId, "Party profile updated");
  commit();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Person and organisation records — the shared entity, not a case's view of
// it (real-world-issues milestone, Part 3)
//
// Before this, a Person or an Organisation could be CREATED — inline, at
// case creation or when adding a party — and never corrected afterward.
// `PersonProfile.tsx` was read-only, and `updatePartyProfile` above edits a
// case's OVERRIDE of a party, never the shared record itself. A telecaller
// who mistyped a date of birth, or who learned a customer's actual address
// three calls into a case, had no way to fix either.
//
// These are the only places `db.people` or `db.organisations` are mutated
// outside of creation. Guarded by `person.update`/`organisation.update`
// (already granted to telecaller, login_executive and manager at `all`
// scope — no permission-grid change needed), because a shared record touches
// every case the person or organisation is on, not just the one open on
// screen.
// ---------------------------------------------------------------------------

export interface PersonUpdateInput {
  fullName?: string | undefined;
  dateOfBirth?: string | undefined;
  addressLine?: string | undefined;
  locality?: string | undefined;
  city?: string | undefined;
  pincode?: string | undefined;
  district?: string | undefined;
  state?: string | undefined;
}

/**
 * Correct a person's own record — name, date of birth, residential address.
 *
 * NOT case-specific. This changes what every case involving this person
 * shows, which is the point: a date of birth is a fact about the person, not
 * about the loan they happen to be applying for.
 */
export function updatePerson(personId: Id, input: PersonUpdateInput, actorUserId: Id): ActionResult {
  const refusal = authorize(actorUserId, "person.update", "all");
  if (refusal) return refusal;

  const person = db.people.find((p) => p.id === personId);
  if (!person) return { ok: false, message: "Person not found." };

  const fullName = input.fullName?.trim();
  const dateOfBirth = input.dateOfBirth?.trim();
  const addressLine = input.addressLine?.trim();
  const locality = input.locality?.trim();
  const city = input.city?.trim();
  const pincode = input.pincode?.trim();
  const district = input.district?.trim();
  const state = input.state?.trim();

  const changes: string[] = [];
  const describe = (label: string, value: string | undefined, before: string | undefined): void => {
    if (!value || value === before) return;
    changes.push(`${label}: ${value}`);
  };
  describe("Name", fullName, person.fullName);
  describe("Date of birth", dateOfBirth, person.dateOfBirth);
  describe("Address", addressLine, person.addressLine);
  describe("Locality", locality, person.locality);
  describe("City", city, person.city);
  describe("PIN code", pincode, person.pincode);
  describe("District", district, person.district);
  describe("State", state, person.state);

  if (changes.length === 0) return { ok: true };

  db.people = db.people.map((p) =>
    p.id !== personId
      ? p
      : {
          ...p,
          ...(fullName ? { fullName } : {}),
          ...(dateOfBirth ? { dateOfBirth } : {}),
          ...(addressLine ? { addressLine } : {}),
          ...(locality ? { locality } : {}),
          ...(city ? { city } : {}),
          ...(pincode ? { pincode } : {}),
          ...(district ? { district } : {}),
          ...(state ? { state } : {}),
        },
  );

  record({
    actorUserId,
    entityType: "person",
    entityId: personId,
    eventType: "person.updated",
    summary: `Profile updated: ${changes.join("; ")}`,
  });

  commit();
  return { ok: true };
}

export interface PersonIdentifierInput {
  /** Editing an existing identifier by id; adding a new one when absent. */
  id?: Id | undefined;
  type: PersonIdentifier["type"];
  value: string;
  isPrimary?: boolean | undefined;
}

/**
 * Add or edit one of a person's identifiers — most often "another phone
 * number" (Part 3's "alternate mobile"), which is not a distinct concept in
 * this schema, only a second `phone`-type row that is not primary.
 *
 * Enforces one primary per type per person, the same invariant
 * `person_identifier_one_primary_per_type` holds in the database
 * (Database/migrations/0002): marking a new or edited identifier primary
 * demotes whichever one previously held that title, in the same write.
 */
export function updatePersonIdentifiers(
  personId: Id,
  input: PersonIdentifierInput,
  actorUserId: Id,
): ActionResult {
  const refusal = authorize(actorUserId, "person.update", "all");
  if (refusal) return refusal;

  const person = db.people.find((p) => p.id === personId);
  if (!person) return { ok: false, message: "Person not found." };

  const value = input.value.trim();
  if (!value) return { ok: false, message: "Give it a value." };

  const makePrimary = input.isPrimary ?? false;
  const existing = input.id ? person.identifiers.find((i) => i.id === input.id) : undefined;
  if (input.id && !existing) {
    return { ok: false, message: "That identifier is not on this person." };
  }

  const identifiers = existing
    ? person.identifiers.map((i) =>
        i.id === existing.id
          ? { ...i, value, isPrimary: makePrimary }
          : makePrimary && i.type === input.type
            ? { ...i, isPrimary: false }
            : i,
      )
    : [
        ...person.identifiers.map((i) =>
          makePrimary && i.type === input.type ? { ...i, isPrimary: false } : i,
        ),
        {
          id: nextId(),
          type: input.type,
          value,
          isPrimary: makePrimary,
          verificationSource: "self_declared" as const,
        },
      ];

  db.people = db.people.map((p) => (p.id === personId ? { ...p, identifiers } : p));

  record({
    actorUserId,
    entityType: "person",
    entityId: personId,
    eventType: "person.identifier_updated",
    summary: existing
      ? `${input.type} updated`
      : `${input.type} added: ${value}`,
  });

  commit();
  return { ok: true };
}

export interface OrganisationUpdateInput {
  canonicalName?: string | undefined;
  industry?: string | undefined;
  city?: string | undefined;
  addressLine?: string | undefined;
  locality?: string | undefined;
  pincode?: string | undefined;
  district?: string | undefined;
  state?: string | undefined;
  businessConstitutionId?: Id | undefined;
  /**
   * Three-valued, like every other GST fact in this codebase — undefined
   * means "leave as recorded". These are PROFILE facts on the business's own
   * record (Database/migrations/0028) and are never read by the Document
   * Requirement Engine, which evaluates `LoanCase.isGstRegistered` instead —
   * see the field comments on `Organisation` in types.ts. Recording one here
   * changes nothing about what any case is asked for.
   */
  isGstRegistered?: boolean | undefined;
  gstin?: string | undefined;
  udyamRegistered?: boolean | undefined;
  udyamNumber?: string | undefined;
}

/**
 * Correct a business's own record — name, address, and its GST/Udyam
 * registration as the business reports it.
 */
export function updateOrganisation(
  organisationId: Id,
  input: OrganisationUpdateInput,
  actorUserId: Id,
): ActionResult {
  const refusal = authorize(actorUserId, "organisation.update", "all");
  if (refusal) return refusal;

  const organisation = db.organisations.find((o) => o.id === organisationId);
  if (!organisation) return { ok: false, message: "Organisation not found." };

  const constitution = input.businessConstitutionId
    ? db.businessConstitutions.find((c) => c.id === input.businessConstitutionId)
    : undefined;

  const canonicalName = input.canonicalName?.trim();
  const industry = input.industry?.trim();
  const city = input.city?.trim();
  const addressLine = input.addressLine?.trim();
  const locality = input.locality?.trim();
  const pincode = input.pincode?.trim();
  const district = input.district?.trim();
  const state = input.state?.trim();
  const gstin = input.gstin?.trim();
  const udyamNumber = input.udyamNumber?.trim();

  const changes: string[] = [];
  const describeText = (label: string, value: string | undefined, before: string | undefined): void => {
    if (!value || value === before) return;
    changes.push(`${label}: ${value}`);
  };
  const describeFlag = (label: string, value: boolean | undefined, before: boolean | undefined): void => {
    if (value === undefined || value === before) return;
    changes.push(`${label}: ${value ? "yes" : "no"}`);
  };
  describeText("Name", canonicalName, organisation.canonicalName);
  describeText("Industry", industry, organisation.industry);
  describeText("City", city, organisation.city);
  describeText("Address", addressLine, organisation.addressLine);
  describeText("Locality", locality, organisation.locality);
  describeText("PIN code", pincode, organisation.pincode);
  describeText("District", district, organisation.district);
  describeText("State", state, organisation.state);
  if (constitution && constitution.id !== organisation.businessConstitutionId) {
    changes.push(`Constitution: ${constitution.name}`);
  }
  describeFlag(
    "GST registered (on this business's record)",
    input.isGstRegistered,
    organisation.isGstRegistered,
  );
  describeText("GSTIN", gstin, organisation.gstin);
  describeFlag("Udyam registered", input.udyamRegistered, organisation.udyamRegistered);
  describeText("Udyam number", udyamNumber, organisation.udyamNumber);

  if (changes.length === 0) return { ok: true };

  db.organisations = db.organisations.map((o) =>
    o.id !== organisationId
      ? o
      : {
          ...o,
          ...(canonicalName ? { canonicalName } : {}),
          ...(industry ? { industry } : {}),
          ...(city ? { city } : {}),
          ...(addressLine ? { addressLine } : {}),
          ...(locality ? { locality } : {}),
          ...(pincode ? { pincode } : {}),
          ...(district ? { district } : {}),
          ...(state ? { state } : {}),
          ...(constitution ? { businessConstitutionId: constitution.id } : {}),
          ...(input.isGstRegistered !== undefined
            ? { isGstRegistered: input.isGstRegistered }
            : {}),
          ...(gstin ? { gstin } : {}),
          ...(input.udyamRegistered !== undefined
            ? { udyamRegistered: input.udyamRegistered }
            : {}),
          ...(udyamNumber ? { udyamNumber } : {}),
        },
  );

  record({
    actorUserId,
    entityType: "organisation",
    entityId: organisationId,
    eventType: "organisation.updated",
    summary: `Profile updated: ${changes.join("; ")}`,
  });

  commit();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Document requirement rules — the engine's configuration (Milestone 9)
// ---------------------------------------------------------------------------

/**
 * Which rule asked for a requirement, and under what conditions.
 *
 * The "why am I being asked for this?" answer. A checklist nobody can
 * interrogate is a checklist people work around.
 */
export function ruleBehind(requirementId: Id): DocumentRequirementRule | undefined {
  const requirement = db.requirements.find((r) => r.id === requirementId);
  if (!requirement?.generatedByRuleCode) return undefined;
  return db.documentRequirementRules.find(
    (rule) => rule.code === requirement.generatedByRuleCode,
  );
}

export interface RuleEditInput {
  name?: string;
  applicability?: ApplicabilityCode;
  applicableFromStage?: ProgressionStage;
  /** 0 or undefined clears the financial-year expansion. */
  financialYears?: number | undefined;
  notes?: string | undefined;
}

/**
 * Edit a rule.
 *
 * Only the four fields a business user has a settled opinion about are
 * editable here: how strongly the document is wanted, when it becomes due,
 * how many years of it, and why. Conditions are edited too (see
 * `setRuleConditions`) but separately, because changing WHEN a rule fires is
 * a different kind of decision from changing WHAT it asks for, and a single
 * form that does both invites the accidental version of each.
 *
 * Cases are NOT regenerated here. A rule change can affect hundreds of cases,
 * and silently rewriting all of them from an admin screen is how a system
 * loses a user's trust. Each case picks the change up the next time anything
 * on it changes, and the case screen offers an explicit "re-evaluate now".
 */
export function updateDocumentRequirementRule(
  ruleId: Id,
  input: RuleEditInput,
  actorUserId: Id,
): ActionResult {
  const rule = db.documentRequirementRules.find((r) => r.id === ruleId);
  if (!rule) return { ok: false, message: "Rule not found." };
  if (input.name !== undefined && !input.name.trim()) {
    return { ok: false, message: "A rule needs a name someone else can recognise." };
  }
  if (input.financialYears !== undefined && input.financialYears > 10) {
    return { ok: false, message: "Ten financial years is already more than any lender asks for." };
  }

  db.documentRequirementRules = db.documentRequirementRules.map((r) => {
    if (r.id !== ruleId) return r;
    const { financialYears, notes, ...rest } = r;
    return {
      ...rest,
      ...(input.name !== undefined ? { name: input.name.trim() } : { name: r.name }),
      ...(input.applicability ? { applicability: input.applicability } : {}),
      ...(input.applicableFromStage
        ? { applicableFromStage: input.applicableFromStage }
        : { applicableFromStage: r.applicableFromStage }),
      ...(input.financialYears ? { financialYears: input.financialYears } : {}),
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
    };
  });

  record({
    actorUserId,
    entityType: "document_requirement_rule",
    entityId: ruleId,
    eventType: "requirement_rule.updated",
    summary: `Rule updated: ${input.name?.trim() ?? rule.name}`,
  });

  commit();
  return { ok: true };
}

/**
 * Take a rule in or out of service.
 *
 * Never deleted — the same never-delete discipline as `rejection_reason` and
 * `document_type` (BR-027). A rule that generated a requirement two years ago
 * still has to be readable when someone asks why that document was collected.
 */
export function setDocumentRequirementRuleActive(
  ruleId: Id,
  isActive: boolean,
  actorUserId: Id,
): ActionResult {
  const rule = db.documentRequirementRules.find((r) => r.id === ruleId);
  if (!rule) return { ok: false, message: "Rule not found." };

  db.documentRequirementRules = db.documentRequirementRules.map((r) =>
    r.id === ruleId ? { ...r, isActive } : r,
  );

  record({
    actorUserId,
    entityType: "document_requirement_rule",
    entityId: ruleId,
    eventType: isActive ? "requirement_rule.activated" : "requirement_rule.deactivated",
    summary: `${rule.name} ${isActive ? "returned to service" : "taken out of service"}`,
  });

  commit();
  return { ok: true };
}

/**
 * Re-evaluate one case's requirements against the current rules, on request.
 *
 * The explicit counterpart to `updateDocumentRequirementRule` not touching
 * cases: after a rule changes, this is how a specific file is brought up to
 * date by someone who has decided it should be.
 */
export function reevaluateRequirements(caseId: Id, actorUserId: Id): ActionResult {
  const loanCase = db.cases.find((c) => c.id === caseId);
  if (!loanCase) return { ok: false, message: "Case not found." };

  const before = db.requirements.filter((r) => r.caseId === caseId).length;
  regenerate(caseId, "Re-evaluated against current rules");
  const after = db.requirements.filter((r) => r.caseId === caseId).length;

  record({
    actorUserId,
    caseId,
    entityType: "document_requirement",
    eventType: "requirements.reevaluated",
    summary:
      after === before
        ? "Re-evaluated: no change"
        : `Re-evaluated: ${before} → ${after} requirements`,
  });

  reconcileReadiness(caseId, "Requirements re-evaluated");
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

  // Real-world-issues milestone, Part 7: the store boundary, not just the
  // hidden Upload button, refuses an actor with no document.upload grant on
  // this case.
  const uploadCase = db.cases.find((c) => c.id === requirement.caseId);
  if (uploadCase) {
    const refusal = authorizeOnCase(actorUserId, uploadCase, "document.upload");
    if (refusal) return refusal;
  }

  const party = db.caseParties.find((p) => p.id === requirement.requiredOfCasePartyId);
  const caseProperty = db.caseProperties.find(
    (p) => p.id === requirement.requiredOfCasePropertyId,
  );
  const documentType = db.documentTypes.find((t) => t.id === requirement.documentTypeId);

  // Ownership is never asked of the user — it follows from what the
  // requirement is already known to be for (BR-030, ADR-007), and it is also
  // what decides the document's storage path, so "where does this file live"
  // and "who does this file belong to" can never disagree.
  //
  // THE SUBJECT WINS OVER THE TYPE'S DECLARED OWNER KIND. A proprietor
  // borrowing in their own name is asked for a balance sheet and a current
  // account statement — both types declared `organisation`, both attached to
  // a PERSON, because on that file the business IS the person and there is no
  // organisation row to own anything. Trusting the type's declaration there
  // resolved to an organisation id that did not exist and threw BR-030 on
  // upload: the checklist asked for a document the user then could not
  // upload. The requirement already knows whose document this is; the type's
  // ownerKind is only the fallback for a case-level row with no subject at
  // all.
  const ownerKind = party?.personId
    ? ("person" as const)
    : party?.organisationId
      ? ("organisation" as const)
      : caseProperty
        ? ("property" as const)
        : ("case" as const);
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

  // A "successful" write that cannot actually be read back is worse than a
  // failed one — it leaves a requirement marked received against a document
  // nobody can open. Confirm the object is there, on the root the backend is
  // presently configured with, before this becomes a DocumentFile at all
  // (Storage reliability milestone).
  let verifiedRoot: string;
  try {
    const [exists, config] = await Promise.all([objectExists(filePath), getStorageConfig()]);
    if (!exists) {
      return {
        ok: false,
        message:
          "The file was sent but could not be confirmed on the storage backend. Nothing was recorded — please try the upload again.",
      };
    }
    verifiedRoot = config.root;
  } catch {
    return {
      ok: false,
      message:
        "The file was sent but the storage backend could not confirm it was stored. Nothing was recorded — please try the upload again.",
    };
  }

  const documentId = nextId();
  db.documents = [
    ...db.documents,
    {
      id: documentId,
      documentTypeId: requirement.documentTypeId,
      ...ownerFields,
      filePath,
      storageRoot: verifiedRoot,
      version,
      ...(previousDocument ? { supersedesDocumentId: previousDocument.id } : {}),
      // A financial-year-scoped requirement (e.g. "ITR — FY2024-25") already
      // pins the year — the row uploaded against is the year selector, so the
      // document inherits it rather than asking again.
      ...(requirement.periodStart ? { periodStart: requirement.periodStart } : {}),
      ...(requirement.periodEnd ? { periodEnd: requirement.periodEnd } : {}),
      // No OCR yet, so the "suggested" type is simply what the requirement
      // already expected — but it is a distinct field from the start, so a
      // future OCR pass can suggest a *different* type without a schema
      // change, and the verify dialog can show "Suggested" next to
      // "Confirmed" today even though the two always agree for now.
      suggestedDocumentTypeId: requirement.documentTypeId,
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

export function verifyDocument(
  requirementId: Id,
  actorUserId: Id,
  notes?: string,
): ActionResult {
  const requirement = db.requirements.find((r) => r.id === requirementId);
  if (!requirement?.satisfiedByDocumentId) {
    return { ok: false, message: "Nothing has been uploaded against this requirement yet." };
  }

  // Real-world-issues milestone, Part 7: a telecaller holds no
  // document.verify grant at any scope, so calling this directly is refused
  // here, not merely left without a Verify button.
  const verifyCase = db.cases.find((c) => c.id === requirement.caseId);
  if (verifyCase) {
    const refusal = authorizeOnCase(actorUserId, verifyCase, "document.verify");
    if (refusal) return refusal;
  }

  const documentType = db.documentTypes.find((t) => t.id === requirement.documentTypeId);
  const trimmedNotes = notes?.trim();

  db.documents = db.documents.map((d) =>
    d.id === requirement.satisfiedByDocumentId
      ? {
          ...d,
          verifiedAt: new Date().toISOString(),
          verifiedBy: actorUserId,
          confirmedDocumentTypeId: requirement.documentTypeId,
          ...(trimmedNotes ? { verificationNotes: trimmedNotes } : {}),
        }
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
    summary: trimmedNotes
      ? `${documentType?.name ?? "Document"} verified: ${trimmedNotes}`
      : `${documentType?.name ?? "Document"} verified`,
  });

  reconcileReadiness(requirement.caseId, "Last applicable requirement verified");
  commit();
  return { ok: true };
}

/**
 * A document uploaded and then found wanting under View — blurry, wrong
 * type, wrong year — is rejected rather than silently re-verified over.
 * The requirement moves to "rejected" (Milestone 9) rather than back to
 * "pending": both need a fresh upload, but only one of them records that a
 * human already spent time on this and told the customer why. The rejected
 * document itself is kept exactly as BR-031 keeps every version, so the next
 * upload supersedes it and the rejection stays visible in history rather than
 * disappearing.
 */
export function rejectDocument(requirementId: Id, reason: string, actorUserId: Id): ActionResult {
  if (!reason.trim()) {
    return { ok: false, message: "A rejection needs a reason. It is a decision with a name on it." };
  }

  const requirement = db.requirements.find((r) => r.id === requirementId);
  if (!requirement?.satisfiedByDocumentId) {
    return { ok: false, message: "Nothing has been uploaded against this requirement yet." };
  }

  // Rejecting is the other half of the same judgement call as verifying, and
  // the UI offers both from the same dialog behind the same grant — the
  // store-level check matches (Part 7).
  const rejectCase = db.cases.find((c) => c.id === requirement.caseId);
  if (rejectCase) {
    const refusal = authorizeOnCase(actorUserId, rejectCase, "document.verify");
    if (refusal) return refusal;
  }

  const documentType = db.documentTypes.find((t) => t.id === requirement.documentTypeId);
  const rejectedDocumentId = requirement.satisfiedByDocumentId;

  db.documents = db.documents.map((d) =>
    d.id === rejectedDocumentId
      ? {
          ...d,
          rejectedAt: new Date().toISOString(),
          rejectedBy: actorUserId,
          rejectionReason: reason.trim(),
        }
      : d,
  );
  db.requirements = db.requirements.map((r) =>
    r.id === requirementId ? { ...r, status: "rejected" as const } : r,
  );

  record({
    actorUserId,
    caseId: requirement.caseId,
    entityType: "document",
    entityId: rejectedDocumentId,
    eventType: "document.rejected",
    summary: `${documentType?.name ?? "Document"} rejected: ${reason.trim()}`,
  });

  commit();
  return { ok: true };
}

/**
 * Remove/Replace milestone: taking the current upload off a requirement
 * without immediately supplying a replacement.
 *
 * Never deletes anything. The DocumentFile row stays in `db.documents`
 * exactly as BR-031 keeps every version — only the requirement's pointer to
 * it is cleared, same as a fresh requirement that has never had anything
 * uploaded against it. The requirement itself is never touched beyond its
 * `status`/`satisfiedByDocumentId`, so it cannot be removed by this action.
 */
export function removeDocument(requirementId: Id, actorUserId: Id): ActionResult {
  const requirement = db.requirements.find((r) => r.id === requirementId);
  if (!requirement?.satisfiedByDocumentId) {
    return { ok: false, message: "Nothing has been uploaded against this requirement yet." };
  }

  // Removing an upload is the mirror image of making one — same grant, same
  // reasoning as Part 7's upload-boundary check.
  const removeCase = db.cases.find((c) => c.id === requirement.caseId);
  if (removeCase) {
    const refusal = authorizeOnCase(actorUserId, removeCase, "document.upload");
    if (refusal) return refusal;
  }

  const documentType = db.documentTypes.find((t) => t.id === requirement.documentTypeId);
  const removedDocumentId = requirement.satisfiedByDocumentId;
  const removedDocument = db.documents.find((d) => d.id === removedDocumentId);

  db.requirements = db.requirements.map((r) => {
    if (r.id !== requirementId) return r;
    const { satisfiedByDocumentId, ...rest } = r;
    return { ...rest, status: "pending" as const };
  });

  record({
    actorUserId,
    caseId: requirement.caseId,
    entityType: "document",
    entityId: removedDocumentId,
    eventType: "document.removed",
    summary: `${documentType?.name ?? "Document"} upload removed: ${removedDocument?.fileName ?? "file"}`,
  });

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
// Custom requirements — the exception the rules could not have known about
// (Telecaller Workflow milestone, Part 6)
// ---------------------------------------------------------------------------

export interface CustomRequirementInput {
  category: DocumentCategory;
  name: string;
  description?: string;
  applicability: "mandatory" | "optional";
}

/**
 * Add a document requirement to ONE case, by hand.
 *
 * WHY THIS IS NOT A RULE EDIT
 *
 * A bank asks for one extra letter on one file. A customer's situation has a
 * wrinkle nobody wrote a rule for. The tempting fix is to add a rule — and a
 * rule added for one file quietly changes what every other open case asks
 * for, which is how a rules engine becomes something users are afraid of.
 * MASTER RULES ARE NOT TOUCHED HERE. The row lands on this case and nowhere
 * else, and `regenerateRequirements` leaves it alone because no rule produced
 * it and therefore no rule's absence can withdraw it.
 *
 * It carries its own name, description and category rather than getting a
 * document type of its own, for the same reason: a per-case document type is
 * master data nobody owns. It points at `other_document` so upload,
 * versioning, verification and the storage path all work on it exactly as
 * they work on a generated requirement — which is the whole point. A custom
 * document that cannot be verified is a note, not a document.
 */
export function addCustomRequirement(
  caseId: Id,
  input: CustomRequirementInput,
  actorUserId: Id,
): ActionResult {
  const loanCase = db.cases.find((c) => c.id === caseId);
  if (!loanCase) return { ok: false, message: "Case not found." };

  const name = input.name.trim();
  if (!name) {
    return { ok: false, message: "Give the document a name the customer would recognise." };
  }

  const documentType = db.documentTypes.find((t) => t.code === CUSTOM_DOCUMENT_TYPE_CODE);
  if (!documentType) {
    return { ok: false, message: "The 'Other Document' type is missing from master data." };
  }

  const duplicate = db.requirements.some(
    (r) =>
      r.caseId === caseId &&
      r.isCustom &&
      r.status !== "not_applicable" &&
      r.customName?.toLowerCase() === name.toLowerCase(),
  );
  if (duplicate) {
    return { ok: false, message: `"${name}" is already on this case's list.` };
  }

  const description = input.description?.trim();
  const requirementId = nextId();

  db.requirements = [
    ...db.requirements,
    {
      id: requirementId,
      caseId,
      documentTypeId: documentType.id,
      status: "pending" as const,
      // Due now. A document somebody deliberately added is not something to
      // start asking for at a later stage.
      applicableFromStage: "documents_pending" as const,
      applicability: input.applicability,
      isCustom: true,
      customName: name,
      customCategory: input.category,
      ...(description ? { customDescription: description } : {}),
    },
  ];

  record({
    actorUserId,
    caseId,
    entityType: "document_requirement",
    entityId: requirementId,
    eventType: "requirement.custom_added",
    summary: `Added by hand: ${name} (${input.applicability})`,
  });

  reconcileReadiness(caseId, "Custom requirement added");
  commit();
  return { ok: true };
}

/**
 * Withdraw a hand-added requirement.
 *
 * Marked `not_applicable` rather than deleted, exactly as a rule-generated
 * row that stops being wanted is (BR-034): someone asked the customer for
 * this, and that they did is part of what happened to the case. A row that
 * already has a document against it keeps it.
 */
export function removeCustomRequirement(requirementId: Id, actorUserId: Id): ActionResult {
  const requirement = db.requirements.find((r) => r.id === requirementId);
  if (!requirement) return { ok: false, message: "Requirement not found." };
  if (!requirement.isCustom) {
    return {
      ok: false,
      message:
        "This requirement came from a rule. Waive it with a reason, or change the rule — " +
        "deleting it here would hide why it was asked for.",
    };
  }

  db.requirements = db.requirements.map((r) =>
    r.id === requirementId ? { ...r, status: "not_applicable" as const } : r,
  );

  record({
    actorUserId,
    caseId: requirement.caseId,
    entityType: "document_requirement",
    entityId: requirementId,
    eventType: "requirement.custom_removed",
    summary: `No longer asked for: ${requirement.customName ?? "custom document"}`,
  });

  reconcileReadiness(requirement.caseId, "Custom requirement removed");
  commit();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

/**
 * Adding a bank to a case (Milestone 10, ADR-036).
 *
 * Replaces the old "Send to Bank", which was one dropdown of branches and no
 * recipients at all. A file goes to a BANK, at a BRANCH, addressed to
 * BANKERS — usually more than one, because a file sent only to the
 * relationship manager stalls the week they are on leave.
 */
export interface AddBankInput {
  caseId: Id;
  branchOrganisationId: Id;
  /** How the file is intended to go out (master data). Records intent only —
   * nothing in AOS sends anything. */
  submissionModeId?: Id;
  recipients: readonly RecipientDraft[];
}

/**
 * Capture what the bank and branch are called RIGHT NOW.
 *
 * Read once, at the moment the bank is added, and never refreshed. Master
 * data is edited — branches get renamed, moved and closed — and an edit must
 * never rewrite what a historical submission says it did (ADR-036).
 */
function snapshotOfBranch(branchOrganisationId: Id): {
  institutionOrganisationId?: Id;
  bankNameAtSubmission?: string;
  branchNameAtSubmission?: string;
  branchAddressAtSubmission?: string;
  branchCityAtSubmission?: string;
  snapshotTakenAt: string;
} {
  const branch = db.organisations.find((o) => o.id === branchOrganisationId);
  const institution = db.organisations.find((o) => o.id === branch?.parentOrganisationId);
  const extension = db.bankBranches.find((b) => b.organisationId === branchOrganisationId);
  const city = db.cities.find((c) => c.id === extension?.cityId);

  return {
    ...(institution ? { institutionOrganisationId: institution.id } : {}),
    ...(institution ? { bankNameAtSubmission: institution.canonicalName } : {}),
    ...(branch ? { branchNameAtSubmission: branch.canonicalName } : {}),
    ...(extension?.addressLine ? { branchAddressAtSubmission: extension.addressLine } : {}),
    ...(city?.name ?? branch?.city
      ? { branchCityAtSubmission: (city?.name ?? branch?.city) as string }
      : {}),
    snapshotTakenAt: new Date().toISOString(),
  };
}

/**
 * Send a case to a bank.
 *
 * Guarded by `submission.create` (real-world-issues milestone, Part 7): a
 * telecaller holds no grant for this action at any scope, so this is the
 * concrete case the milestone names — "the underlying operation must reject
 * a telecaller attempting to send a case to a bank" — not just a hidden
 * button.
 */
export function createSubmission(input: AddBankInput, actorUserId: Id): ActionResult {
  const loanCase = db.cases.find((c) => c.id === input.caseId);
  if (!loanCase) return { ok: false, message: "Case not found." };

  const refusal = authorizeOnCase(actorUserId, loanCase, "submission.create");
  if (refusal) return refusal;

  const branch = db.organisations.find((o) => o.id === input.branchOrganisationId);
  if (!branch) return { ok: false, message: "That branch no longer exists." };

  // Validated in the domain layer, so the prototype and the server cannot
  // disagree about what a usable recipient list is.
  const validated = validateRecipients(input.recipients);
  if (!validated.ok) return { ok: false, message: describeProblem(validated.problem) };

  const submissionId = nextId();
  const now = new Date().toISOString();
  const snapshot = snapshotOfBranch(input.branchOrganisationId);

  // Created in not_submitted: a bank, a branch and the bankers are chosen,
  // but the file has not physically gone out. The case stage advances on
  // dispatch, not on this.
  db.submissions = [
    ...db.submissions,
    {
      id: submissionId,
      caseId: input.caseId,
      branchOrganisationId: input.branchOrganisationId,
      ...(input.submissionModeId ? { submissionModeId: input.submissionModeId } : {}),
      ...snapshot,
      status: "not_submitted",
      createdAt: now,
    },
  ];

  db.submissionRecipients = [
    ...db.submissionRecipients,
    ...validated.recipients.map((recipient): SubmissionRecipient => ({
      id: nextId(),
      submissionId,
      ...(recipient.bankContactId ? { bankContactId: recipient.bankContactId } : {}),
      email: recipient.email,
      ...(recipient.name ? { contactName: recipient.name } : {}),
      ...(recipient.designation ? { designation: recipient.designation } : {}),
      isPrimary: recipient.isPrimary,
      recipientKind: recipient.kind,
      displayOrder: recipient.displayOrder,
      createdAt: now,
    })),
  ];

  record({
    actorUserId,
    caseId: input.caseId,
    entityType: "submission",
    entityId: submissionId,
    eventType: "submission.created",
    summary:
      `${snapshot.branchNameAtSubmission ?? branch.canonicalName} added — ` +
      `${describeRecipientCount(validated.recipients.length)}, not yet dispatched`,
  });

  commit();
  return { ok: true };
}

/** The bankers one submission was addressed to, in the order they were entered. */
export function recipientsOf(submissionId: Id, source: Database = db): SubmissionRecipient[] {
  return source.submissionRecipients
    .filter((recipient) => recipient.submissionId === submissionId)
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder);
}

/**
 * How a submission's counterparty reads, from the SNAPSHOT rather than the
 * live master data.
 *
 * Falls back to the current branch name only for rows that predate the
 * snapshot — which in this prototype is the seed, and in the database is
 * anything before Database/migrations/0024.
 */
export function counterpartyOf(submission: Submission, source: Database = db): string {
  const bankName = submission.bankNameAtSubmission;
  const branchName =
    submission.branchNameAtSubmission ??
    source.organisations.find((o) => o.id === submission.branchOrganisationId)?.canonicalName;
  if (branchName === undefined) return "Unknown branch";
  if (bankName === undefined) return branchName;
  return describeCounterparty({ bankName, branchName, takenAt: submission.createdAt });
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

  // The snapshot, not the live branch name: what this file was sent to is a
  // fact about the past, and an event describing it must not change when
  // somebody renames a branch next year (ADR-036).
  const counterparty = counterpartyOf(submission);
  const reason = db.rejectionReasons.find((r) => r.id === extra?.rejectionReasonId);

  record({
    actorUserId,
    caseId: submission.caseId,
    entityType: "submission",
    entityId: submissionId,
    eventType: `submission.${status}`,
    summary:
      status === "rejected"
        ? `${counterparty} rejected: ${reason?.name ?? "reason recorded"}`
        : `${counterparty} → ${status.replace(/_/g, " ")}`,
  });

  autoAdvance(submission.caseId, `${counterparty} ${status.replace(/_/g, " ")}`);
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

/**
 * Rename a document type, or change what it says about itself.
 *
 * The Telecaller Workflow milestone added three of the four editable fields
 * here. The catalogue ships names, local names, descriptions and categories
 * researched against how lenders in this market actually ask — and every one
 * of them stays master data a business user owns, because the right wording
 * for a Coimbatore branch is a thing the branch knows and a developer does
 * not.
 */
export function updateDocumentTypeDetails(
  id: Id,
  patch: {
    name?: string;
    localName?: string;
    description?: string;
    /** Comma- or newline-separated in the form; a real list here. */
    examples?: string[];
    category?: DocumentCategory;
  },
  actorUserId: Id,
): ActionResult {
  const existing = db.documentTypes.find((t) => t.id === id);
  if (!existing) return { ok: false, message: "Document type not found." };
  const name = patch.name?.trim();
  if (patch.name !== undefined && !name) return { ok: false, message: "Name cannot be blank." };

  const localName = patch.localName?.trim();

  db.documentTypes = db.documentTypes.map((t) => {
    if (t.id !== id) return t;
    // Clearing the local name is a real edit — spread-with-undefined would
    // leave the old one in place — but only when the caller actually said so.
    // A patch that never mentions the field leaves it alone.
    const { localName: keptLocalName, examples: keptExamples, ...rest } = t;
    const nextLocalName = patch.localName === undefined ? keptLocalName : localName;
    // An emptied examples list is a real edit — "actually, only these two
    // count now" — so an explicitly-empty array clears it, while a patch that
    // never mentions the field leaves it alone.
    const nextExamples =
      patch.examples === undefined
        ? keptExamples
        : patch.examples.map((e) => e.trim()).filter(Boolean);
    return {
      ...rest,
      ...(name ? { name } : {}),
      ...(nextLocalName ? { localName: nextLocalName } : {}),
      ...(patch.description?.trim() ? { description: patch.description.trim() } : {}),
      ...(nextExamples && nextExamples.length > 0 ? { examples: nextExamples } : {}),
      ...(patch.category ? { category: patch.category } : {}),
    };
  });
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
  /**
   * Optional since Milestone 10 (ADR-036). Many of the addresses a file goes
   * to are desks — "homeloans.cbe@bank.com" is an address, not a person — and
   * demanding a name for one only ever produces a made-up name.
   */
  fullName?: string;
  institutionOrganisationId: Id;
  /** Optional — a regional manager belongs to no single branch, and that is
   * a complete record rather than a partial one. */
  branchOrganisationId?: Id;
  relationshipRoleId?: Id;
  designation?: string;
  workMobile?: string;
  workEmail?: string;
  /** At most one per branch among the active contacts. */
  isPrimaryContact?: boolean;
  notes?: string;
}

function contactFields(input: RelationshipManagerInput): Partial<BankContact> {
  return {
    ...(trimmed(input.fullName) ? { contactName: trimmed(input.fullName) as string } : {}),
    ...(input.branchOrganisationId ? { branchOrganisationId: input.branchOrganisationId } : {}),
    ...(input.relationshipRoleId ? { relationshipRoleId: input.relationshipRoleId } : {}),
    ...(trimmed(input.designation) ? { designation: trimmed(input.designation) as string } : {}),
    ...(trimmed(input.workMobile) ? { workMobile: trimmed(input.workMobile) as string } : {}),
    ...(trimmed(input.workEmail) ? { workEmail: trimmed(input.workEmail) as string } : {}),
    ...(input.isPrimaryContact ? { isPrimaryContact: true } : {}),
    ...(trimmed(input.notes) ? { notes: trimmed(input.notes) as string } : {}),
  };
}

/** The display name for a contact, whether it is a person or a desk. */
export function contactLabel(contact: BankContact, source: Database = db): string {
  return (
    contact.contactName ??
    source.people.find((person) => person.id === contact.personId)?.fullName ??
    contact.workEmail ??
    "Unnamed contact"
  );
}

/**
 * A contact must be reachable or nameable as something — all three of person,
 * name and email blank is an empty row, not a permissive one. Mirrors the
 * `bank_contact_is_identifiable` check (Database/migrations/0024).
 */
function contactIsIdentifiable(input: RelationshipManagerInput): boolean {
  return trimmed(input.fullName) !== undefined || trimmed(input.workEmail) !== undefined;
}

/**
 * At most one primary per branch, among contacts still current. A second
 * primary is a data entry mistake, not a preference — and the Add Bank
 * workflow reads this flag to decide who to address a file to first.
 */
function demotePrimaries(contacts: BankContact[], branchId: Id | undefined, keepId: Id): BankContact[] {
  if (branchId === undefined) return contacts;
  return contacts.map((contact) =>
    contact.id !== keepId &&
    contact.branchOrganisationId === branchId &&
    contact.isPrimaryContact
      ? { ...contact, isPrimaryContact: false }
      : contact,
  );
}

export function createRelationshipManager(
  input: RelationshipManagerInput,
  actorUserId: Id,
): ActionResult {
  if (!contactIsIdentifiable(input)) {
    return { ok: false, message: "Give the contact a name or an email address." };
  }
  if (trimmed(input.workEmail) && !isEmailShaped(input.workEmail as string)) {
    return { ok: false, message: `"${input.workEmail}" does not look like an email address.` };
  }
  const institution = db.organisations.find((org) => org.id === input.institutionOrganisationId);
  if (!institution) return { ok: false, message: "That lender no longer exists." };

  const name = trimmed(input.fullName);
  const contactId = nextId();

  // A `person` row is created only when there is a person: a named manager
  // who moves to another bank next year is one new contact against the same
  // person, which is the whole point of ADR-006 and ADR-014. A shared mailbox
  // is nobody, and inventing a person to hold it would put fictional people
  // into an operational contact list (ADR-036).
  const person: Person | undefined =
    name === undefined
      ? undefined
      : { id: nextId(), fullName: name, aliases: [], identifiers: [] };

  const contact: BankContact = {
    id: contactId,
    ...(person ? { personId: person.id } : {}),
    institutionOrganisationId: institution.id,
    isActive: true,
    ...contactFields(input),
  };

  db = {
    ...db,
    ...(person ? { people: [...db.people, person] } : {}),
    bankContacts: demotePrimaries(
      [...db.bankContacts, contact],
      input.isPrimaryContact ? input.branchOrganisationId : undefined,
      contactId,
    ),
  };

  record({
    actorUserId,
    entityType: "bank_contact",
    entityId: contactId,
    eventType: "master_data.created",
    summary: `Contact added at ${institution.canonicalName}: ${contactLabel(contact)}`,
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
  if (!contactIsIdentifiable(input)) {
    return { ok: false, message: "Give the contact a name or an email address." };
  }
  if (trimmed(input.workEmail) && !isEmailShaped(input.workEmail as string)) {
    return { ok: false, message: `"${input.workEmail}" does not look like an email address.` };
  }
  if (!db.organisations.some((org) => org.id === input.institutionOrganisationId)) {
    return { ok: false, message: "That lender no longer exists." };
  }

  const name = trimmed(input.fullName);

  db = {
    ...db,
    people: db.people.map((person) =>
      existing.personId !== undefined && person.id === existing.personId && name !== undefined
        ? { ...person, fullName: name }
        : person,
    ),
    bankContacts: demotePrimaries(
      db.bankContacts.map((contact) =>
        contact.id === contactId
          ? {
              id: contact.id,
              ...(contact.personId ? { personId: contact.personId } : {}),
              institutionOrganisationId: input.institutionOrganisationId,
              isActive: contact.isActive,
              ...contactFields(input),
            }
          : contact,
      ),
      input.isPrimaryContact ? input.branchOrganisationId : undefined,
      contactId,
    ),
  };

  record({
    actorUserId,
    entityType: "bank_contact",
    entityId: contactId,
    eventType: "master_data.updated",
    summary: `Contact updated: ${name ?? trimmed(input.workEmail) ?? "contact"}`,
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
  const label = contactLabel(existing);

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
    summary: `Contact ${isActive ? "reactivated" : "marked as moved on"}: ${label}`,
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

