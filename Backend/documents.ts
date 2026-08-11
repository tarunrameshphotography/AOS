/**
 * Documents and their requirements — server-side, for one case.
 *
 * Stage 3C. The chain the audit found broken: Product -> Document Rules ->
 * Requirements -> Case Documents -> Upload -> Storage -> Verification ->
 * Requirement Satisfaction -> Progress -> Stage readiness. Every step here
 * was already real in the schema and the pure domain layer
 * (`@domain/requirements`, `@domain/storage`, `@domain/case/transitions`);
 * this file is what wires them to Postgres and to the storage backend.
 *
 * NOT HERE, deliberately (Stage 3C scope, per the audit and the mission that
 * followed it): bank submissions, offers, the case timeline UI, Gmail
 * submission, requirement waivers, hand-added ("custom") requirements,
 * co-applicants and properties (Backend/cases.ts does not create them yet, so
 * there is nothing here to attach a property-scoped requirement to). Every
 * one of those either has no reachable case shape today or is a separate
 * decision the mission asked not to fold in silently.
 */

import {
  summariseProgress,
  type ProgressSummary,
  type Requirement as ProgressRequirement,
} from "@domain/requirements/index.js";
import { evaluateTransition, type CaseSnapshot } from "@domain/case/transitions.js";
import type { CaseStage } from "@domain/case/stages.js";
import { resolveDocumentOwner, buildStoragePath, type DocumentOwnerFields } from "@domain/storage/path.js";
import { nextVersion } from "@domain/storage/versioning.js";

import type { Queryable } from "./db.js";
import { can, canActOnCase, type Actor } from "./authorize.js";
import { ApiError, refusalMessage } from "./http.js";
import {
  recordDocumentEvent,
  recordRequirementAddedEvent,
  recordRequirementWaivedEvent,
  recordSystemCaseEvent,
} from "./events.js";
import { regenerateRequirements } from "./requirements.js";
import { storageAdapter, getObjectWithContentType } from "./storage-client.js";
import { submissionOutcomeFacts } from "./case-stage.js";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Loading the case (the slice this module needs, not the whole row)
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
  if (!canActOnCase(actor, header.ownerUserId, "document.read")) {
    throw new ApiError(404, "No such case, or you do not have access to it.");
  }
  if (permission !== "document.read" && !canActOnCase(actor, header.ownerUserId, permission)) {
    throw new ApiError(403, refusalMessage(permission));
  }
}

// ---------------------------------------------------------------------------
// Reading — requirements, their current document, and progress
// ---------------------------------------------------------------------------

/**
 * WHOSE document this is — resolved from the requirement's structural subject,
 * never assembled from a display string.
 *
 * THE PROBLEM IT SOLVES. A case with a co-applicant generated two rows called
 * "PAN Card", two called "Aadhaar Card" and two called "Bank Statement", and
 * nothing on screen said which belonged to whom. The rows were never
 * ambiguous in the database — `required_of_case_party_id` has pointed at the
 * right party since 0005 — but the screen rendered only the document type, so
 * a login executive had to guess, and a duplicated-looking list is a list
 * people stop trusting (the same failure the 0027 audit found for financial
 * years).
 *
 * `kind` and `role` are CODES, not sentences: the label a screen prints is a
 * presentation decision, and shipping it from here would mean the API had to
 * be redeployed to reword a heading. `name` is the party's or property's own
 * name, which only the database knows.
 */
export interface RequirementSubject {
  readonly kind: "party" | "property" | "case";
  /** `case_party.role` or `case_property.role`. Absent on a case-level row. */
  readonly role: string | null;
  /** The person's, organisation's or property's own name, where it has one. */
  readonly name: string | null;
}

export interface RequirementView {
  readonly id: string;
  readonly documentTypeCode: string;
  readonly applicableFromStage: string;
  readonly applicability: string;
  readonly status: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly requiredOfCasePartyId: string | null;
  readonly requiredOfCasePropertyId: string | null;
  readonly subject: RequirementSubject;
  readonly generatedByRuleCode: string | null;
  /** Why this requirement exists, from the rule that generated it. Null on a
   * hand-added row: no rule produced it, so the honest answer is that a person
   * decided, and `isCustom` already says so. */
  readonly generatedByRuleName: string | null;
  readonly generatedByRuleNotes: string | null;
  /** Added by hand for this case only (`document_requirement.is_custom`, 0026)
   * — an Additional Document, not something a rule asked for. */
  readonly isCustom: boolean;
  readonly customName: string | null;
  readonly reason: string | null;
  /** Set together, never one without the other (`document_requirement_waiver_is_complete`,
   * 0005) — who excused this requirement and when, so a waived row on screen
   * can say more than just "Waived" (BR-035). */
  readonly waivedByUserId: string | null;
  readonly waivedAt: string | null;
  readonly document: {
    readonly id: string;
    readonly fileName: string | null;
    readonly fileSizeBytes: number | null;
    readonly version: number;
    readonly uploadedAt: string;
    readonly uploadedByUserId: string | null;
    readonly verifiedAt: string | null;
    readonly verifiedByUserId: string | null;
  } | null;
}

interface RequirementRow {
  id: string;
  document_type_code: string;
  applicable_from_stage: string;
  applicability: string;
  status: string;
  period_start: string | null;
  period_end: string | null;
  required_of_case_party_id: string | null;
  required_of_case_property_id: string | null;
  party_role: string | null;
  party_name: string | null;
  property_role: string | null;
  property_name: string | null;
  generated_by_rule_code: string | null;
  generated_by_rule_name: string | null;
  generated_by_rule_notes: string | null;
  is_custom: boolean;
  custom_name: string | null;
  reason: string | null;
  waived_by: string | null;
  waived_at: string | null;
  document_id: string | null;
  file_name: string | null;
  file_size_bytes: string | null;
  version: number | null;
  uploaded_at: string | null;
  uploaded_by: string | null;
  verified_at: string | null;
  verified_by: string | null;
}

/**
 * The requirement projection, written once.
 *
 * `listCaseRequirements` and `requirementView` used to carry two copies of
 * this select and two copies of the mapper below, and adding a field meant
 * editing four places or shipping a screen where a freshly-uploaded row was
 * missing what the list showed. One definition, two callers, one `where`
 * clause each.
 */
const REQUIREMENT_SELECT = `
  select r.id, dt.code as document_type_code, r.applicable_from_stage,
         a.code as applicability, r.status, r.period_start::text, r.period_end::text,
         r.required_of_case_party_id, r.required_of_case_property_id,
         cpa.role as party_role,
         coalesce(pp.full_name, po.canonical_name) as party_name,
         cpr.role as property_role,
         -- A property has no single "name": what identifies it on a checklist
         -- is the building or the locality, in that order of specificity.
         coalesce(prop.building_name, prop.locality, prop.door_number) as property_name,
         rule.code as generated_by_rule_code, rule.name as generated_by_rule_name,
         rule.notes as generated_by_rule_notes,
         r.is_custom, r.custom_name, r.reason, r.waived_by, r.waived_at::text,
         d.id as document_id, d.file_name, d.file_size_bytes, d.version,
         d.uploaded_at::text, d.uploaded_by, d.verified_at::text, d.verified_by
    from document_requirement r
    join document_type dt on dt.id = r.document_type_id
    left join requirement_applicability a on a.id = r.applicability_id
    left join document_requirement_rule rule on rule.id = r.generated_by_rule_id
    left join case_party cpa on cpa.id = r.required_of_case_party_id
    left join person pp on pp.id = cpa.person_id
    left join organisation po on po.id = cpa.organisation_id
    left join case_property cpr on cpr.id = r.required_of_case_property_id
    left join property prop on prop.id = cpr.property_id
    left join lateral (
      select doc.*
        from document doc
       where doc.document_type_id = r.document_type_id
         and doc.period_start is not distinct from r.period_start
         and (
           (cpa.person_id is not null and doc.person_id = cpa.person_id) or
           (cpa.organisation_id is not null and doc.organisation_id = cpa.organisation_id) or
           (cpr.property_id is not null and doc.property_id = cpr.property_id) or
           (cpa.id is null and cpr.id is null and doc.case_id = r.case_id)
         )
       order by doc.version desc
       limit 1
    ) d on true`;

function subjectOf(row: RequirementRow): RequirementSubject {
  if (row.required_of_case_party_id) {
    return { kind: "party", role: row.party_role, name: row.party_name };
  }
  if (row.required_of_case_property_id) {
    return { kind: "property", role: row.property_role, name: row.property_name };
  }
  return { kind: "case", role: null, name: null };
}

function requirementFromRow(row: RequirementRow): RequirementView {
  return {
    id: row.id,
    documentTypeCode: row.document_type_code,
    applicableFromStage: row.applicable_from_stage,
    applicability: row.applicability,
    status: row.status,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    requiredOfCasePartyId: row.required_of_case_party_id,
    requiredOfCasePropertyId: row.required_of_case_property_id,
    subject: subjectOf(row),
    generatedByRuleCode: row.generated_by_rule_code,
    generatedByRuleName: row.generated_by_rule_name,
    generatedByRuleNotes: row.generated_by_rule_notes,
    isCustom: row.is_custom === true,
    customName: row.custom_name,
    reason: row.reason,
    waivedByUserId: row.waived_by,
    waivedAt: row.waived_at,
    document: row.document_id
      ? {
          id: row.document_id,
          fileName: row.file_name,
          fileSizeBytes: row.file_size_bytes === null ? null : Number(row.file_size_bytes),
          version: row.version ?? 1,
          uploadedAt: row.uploaded_at as string,
          uploadedByUserId: row.uploaded_by,
          verifiedAt: row.verified_at,
          verifiedByUserId: row.verified_by,
        }
      : null,
  };
}

/**
 * Every requirement this case has, with the document currently standing
 * against it — the latest version, for the matching owner, document type and
 * period — if one has been uploaded. This IS the join across the chain the
 * audit traced and found nowhere wired: requirement to document, through the
 * subject the requirement is for.
 */
export async function listCaseRequirements(
  client: Queryable,
  actor: Actor,
  caseId: string,
): Promise<{ caseStage: CaseStage; requirements: RequirementView[]; progress: ProgressSummary }> {
  const header = await loadCaseHeader(client, caseId);
  requireCaseAccess(actor, header, "document.read");

  await regenerateRequirements(client, caseId);

  const { rows } = await client.query<RequirementRow>(
    `${REQUIREMENT_SELECT}
      where r.case_id = $1 and r.status <> 'not_applicable'
      order by dt.display_order, dt.code, r.period_start desc nulls last`,
    [caseId],
  );

  const requirements: RequirementView[] = rows.map(requirementFromRow);

  const progress = summariseProgress(
    requirements.map(
      (row): ProgressRequirement => ({
        id: row.id,
        status: row.status as ProgressRequirement["status"],
        applicableFromStage: row.applicableFromStage as ProgressRequirement["applicableFromStage"],
        applicability: row.applicability as ProgressRequirement["applicability"],
      }),
    ),
    header.stage,
  );

  return { caseStage: header.stage, requirements, progress };
}

// ---------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------

interface RequirementSubjectRow {
  id: string;
  case_id: string;
  document_type_id: string;
  document_type_code: string;
  status: string;
  period_start: string | null;
  period_end: string | null;
  case_party_id: string | null;
  party_person_id: string | null;
  party_organisation_id: string | null;
  case_property_id: string | null;
  property_id: string | null;
}

async function loadRequirementSubject(
  client: Queryable,
  caseId: string,
  requirementId: string,
): Promise<RequirementSubjectRow> {
  const { rows } = await client.query<RequirementSubjectRow>(
    `select r.id, r.case_id, r.document_type_id, dt.code as document_type_code, r.status,
            r.period_start::text, r.period_end::text,
            cpa.id as case_party_id, cpa.person_id as party_person_id,
            cpa.organisation_id as party_organisation_id,
            cpr.id as case_property_id, cpr.property_id
       from document_requirement r
       join document_type dt on dt.id = r.document_type_id
       left join case_party cpa on cpa.id = r.required_of_case_party_id
       left join case_property cpr on cpr.id = r.required_of_case_property_id
      where r.id = $1 and r.case_id = $2`,
    [requirementId, caseId],
  );
  const row = rows[0];
  if (!row) throw new ApiError(404, "No such requirement on this case.");
  return row;
}

function ownerFieldsFor(subject: RequirementSubjectRow, caseId: string): DocumentOwnerFields {
  if (subject.party_person_id) return { ownerKind: "person", personId: subject.party_person_id };
  if (subject.party_organisation_id) {
    return { ownerKind: "organisation", organisationId: subject.party_organisation_id };
  }
  if (subject.property_id) return { ownerKind: "property", propertyId: subject.property_id };
  return { ownerKind: "case", caseId };
}

/**
 * Upload a document against one requirement.
 *
 * The invariant Phase 3 asks for: a document is not created until bytes are
 * durably stored AND the Postgres row exists. Bytes go to the storage
 * backend first; the metadata insert only happens after that call succeeds,
 * so a storage failure never produces a database row with nothing behind it.
 * The reverse case — bytes land but the surrounding request transaction later
 * rolls back — is not fully eliminated (object storage has no transactions of
 * its own), but paths are versioned and never reused (BR-031), so a stray
 * object is inert rather than corrupting: nothing ever points at it.
 */
export async function uploadDocument(
  client: Queryable,
  actor: Actor,
  caseId: string,
  requirementId: string,
  file: { bytes: Uint8Array; fileName: string; contentType?: string },
): Promise<RequirementView> {
  const header = await loadCaseHeader(client, caseId);
  requireCaseAccess(actor, header, "document.upload");

  if (file.bytes.byteLength === 0) throw new ApiError(400, "The file is empty.");
  if (file.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new ApiError(413, "That file is larger than AOS currently accepts (25 MB).");
  }

  const subject = await loadRequirementSubject(client, caseId, requirementId);
  const ownerFields = ownerFieldsFor(subject, caseId);
  const owner = resolveDocumentOwner(ownerFields);

  const { rows: versionRows } = await client.query<{ version: number }>(
    `select max(version) as version from document
      where document_type_id = $1
        and period_start is not distinct from $2
        and (
          ($3::uuid is not null and person_id = $3) or
          ($4::uuid is not null and organisation_id = $4) or
          ($5::uuid is not null and property_id = $5) or
          ($3::uuid is null and $4::uuid is null and $5::uuid is null and case_id = $6)
        )`,
    [
      subject.document_type_id,
      subject.period_start,
      ownerFields.personId ?? null,
      ownerFields.organisationId ?? null,
      ownerFields.propertyId ?? null,
      caseId,
    ],
  );
  const version = nextVersion(
    versionRows[0]?.version ? { version: versionRows[0].version } : undefined,
  );

  const path = buildStoragePath({
    owner,
    documentTypeCode: subject.document_type_code,
    version,
    ...(subject.period_start ? { periodStart: subject.period_start } : {}),
    fileName: file.fileName,
  });

  let stored;
  try {
    stored = await storageAdapter.put(path, file.bytes, {
      ...(file.contentType ? { contentType: file.contentType } : {}),
    });
  } catch (error) {
    throw new ApiError(
      502,
      "The document could not be stored. Check that the storage backend is running and try again.",
    );
  }

  const inserted = await client.query<{ id: string }>(
    `insert into document
       (owner_kind, person_id, property_id, organisation_id, case_id,
        document_type_id, file_path, file_name, file_size_bytes,
        period_start, period_end, version, uploaded_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning id`,
    [
      owner.kind,
      ownerFields.personId ?? null,
      ownerFields.propertyId ?? null,
      ownerFields.organisationId ?? null,
      owner.kind === "case" ? caseId : null,
      subject.document_type_id,
      stored.path,
      file.fileName,
      stored.sizeBytes,
      subject.period_start,
      subject.period_end,
      version,
      actor.userId,
    ],
  );
  const documentId = inserted.rows[0]!.id;

  // A fresh upload is `received`: someone has to look at it before it counts
  // toward progress (BR-032). Never re-marks a requirement that is already
  // `verified` back to received on its own — an upload of a NEW version over
  // an already-verified requirement is a real, deliberate re-open, and Stage
  // 3C does not build that flow; today's upload path only reaches a
  // requirement that is not yet satisfied.
  await client.query(
    `update document_requirement set status = 'received', reason = null where id = $1`,
    [requirementId],
  );

  await recordDocumentEvent(client, {
    actorUserId: actor.userId,
    documentId,
    caseId,
    eventType: "document.uploaded",
    payloadAfter: { requirementId, documentTypeId: subject.document_type_id, version },
  });

  await reconcileStage(client, caseId, {
    entityType: "document_requirement",
    entityId: requirementId,
  });

  return await requirementView(client, requirementId);
}

async function requirementView(client: Queryable, requirementId: string): Promise<RequirementView> {
  const { rows } = await client.query<RequirementRow>(`${REQUIREMENT_SELECT} where r.id = $1`, [
    requirementId,
  ]);
  const row = rows[0];
  if (!row) throw new ApiError(404, "No such requirement.");
  return requirementFromRow(row);
}

// ---------------------------------------------------------------------------
// Verifying / rejecting
// ---------------------------------------------------------------------------

/**
 * A human decides whether an uploaded document actually satisfies a
 * requirement (BR-032). The server enforces this, not just the button: a
 * requirement with nothing uploaded against it cannot be verified, and
 * verifying always names the current document as the one that satisfied it —
 * `document_requirement_verified_has_document` would refuse the write
 * otherwise, but the check here exists so the refusal reads as a sentence
 * rather than a constraint-violation error.
 */
export async function decideDocument(
  client: Queryable,
  actor: Actor,
  caseId: string,
  requirementId: string,
  body: Record<string, unknown>,
): Promise<RequirementView> {
  const header = await loadCaseHeader(client, caseId);
  requireCaseAccess(actor, header, "document.verify");

  const decision = body.decision === "verified" || body.decision === "rejected" ? body.decision : null;
  if (!decision) throw new ApiError(400, "decision must be \"verified\" or \"rejected\".");
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (decision === "rejected" && reason.length === 0) {
    throw new ApiError(400, "A rejection needs a reason, so the case knows what to ask for again.");
  }

  const subject = await loadRequirementSubject(client, caseId, requirementId);
  const current = await requirementView(client, requirementId);
  if (!current.document) {
    throw new ApiError(409, "Nothing has been uploaded against this requirement yet.");
  }
  if (current.status === "verified" && decision === "verified") {
    return current;
  }

  if (decision === "verified") {
    await client.query(`update document set verified_by = $1, verified_at = now() where id = $2`, [
      actor.userId,
      current.document.id,
    ]);
    await client.query(
      `update document_requirement set status = 'verified', satisfied_by_document_id = $1, reason = null
        where id = $2`,
      [current.document.id, requirementId],
    );
    await recordDocumentEvent(client, {
      actorUserId: actor.userId,
      documentId: current.document.id,
      caseId,
      eventType: "document.verified",
      payloadAfter: { requirementId },
    });
  } else {
    await client.query(
      `update document_requirement set status = 'rejected', satisfied_by_document_id = null, reason = $1
        where id = $2`,
      [reason, requirementId],
    );
    await recordDocumentEvent(client, {
      actorUserId: actor.userId,
      documentId: current.document.id,
      caseId,
      eventType: "document.rejected",
      payloadAfter: { requirementId },
    });
  }

  await reconcileStage(client, caseId, {
    entityType: "document_requirement",
    entityId: requirementId,
  });

  return await requirementView(client, requirementId);
}

// ---------------------------------------------------------------------------
// Waiving (Phase 4 — case completeness)
// ---------------------------------------------------------------------------

/**
 * Excuse a requirement without pretending it was satisfied (BR-035).
 *
 * `requirement.waive` is a separate permission from `document.verify` — a
 * Telecaller who may correct a requested amount holds neither, a Login
 * Executive holds both (`src/domain/permissions/roles.ts`) — because waiving
 * sends a file to a bank with a gap in it on purpose, which is a bigger
 * decision than confirming a document is readable.
 *
 * A reason is mandatory: `document_requirement_waiver_is_reasoned` (0005)
 * would refuse the write anyway, but the check here exists so the refusal
 * reads as a sentence. `verified` and `not_applicable` are refused for the
 * same reason `decideDocument` refuses to verify a requirement nothing was
 * uploaded against: a waiver is a decision about something still missing, not
 * a way to un-verify a document already confirmed, and a `not_applicable`
 * requirement means the case does not need this at all — there is nothing
 * left for a waiver to excuse. Waiving an already-waived requirement again
 * (a retried request, or the row genuinely being re-opened by a later
 * regeneration and re-waived) is a no-op that writes no second event, the
 * same discipline `updateCase` and `setHold` already apply.
 */
export async function waiveRequirement(
  client: Queryable,
  actor: Actor,
  caseId: string,
  requirementId: string,
  body: Record<string, unknown>,
): Promise<RequirementView> {
  const header = await loadCaseHeader(client, caseId);
  requireCaseAccess(actor, header, "requirement.waive");

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length === 0) {
    throw new ApiError(400, "A waiver needs a reason. It is a decision with a name on it.");
  }

  const current = await requirementView(client, requirementId);
  if (current.status === "waived") return current;
  if (current.status === "not_applicable") {
    throw new ApiError(409, "This case does not need this requirement — there is nothing to waive.");
  }
  if (current.status === "verified") {
    throw new ApiError(409, "This requirement is already verified and cannot be waived.");
  }

  await client.query(
    `update document_requirement
        set status = 'waived', waived_by = $1, waived_at = now(), reason = $2
      where id = $3`,
    [actor.userId, reason, requirementId],
  );

  // The reason stays off the event payload — see recordRequirementWaivedEvent's
  // own comment. Only the document type is carried, and it is a code, not a
  // customer- or employee-identifying fact.
  await recordRequirementWaivedEvent(client, {
    actorUserId: actor.userId,
    caseId,
    requirementId,
    payloadAfter: { documentTypeCode: current.documentTypeCode },
  });

  // Waiving can be the last outstanding requirement on a file — the same
  // stage reconciliation an upload or a verification triggers.
  await reconcileStage(client, caseId, {
    entityType: "document_requirement",
    entityId: requirementId,
  });

  return await requirementView(client, requirementId);
}

// ---------------------------------------------------------------------------
// Additional documents — a requirement added by hand, for this case only
// ---------------------------------------------------------------------------

export interface AddRequirementInput {
  documentTypeCode?: unknown;
  casePartyId?: unknown;
  casePropertyId?: unknown;
  note?: unknown;
}

/**
 * Ask this case for one more document.
 *
 * WHAT THIS IS FOR. A lender asks for something the rule pack does not cover —
 * a specific NOC, a letter explaining a gap in banking, a second address
 * proof for a shared premises. Before this the only recourse was to chase it
 * outside AOS, which means it is not on the checklist, not in storage, not
 * verified and not in the submission package.
 *
 * WHAT IT IS NOT. It is not a way around the requirement engine. It ADDS a
 * row; it can neither remove nor weaken one a rule generated, and it cannot
 * invent a document type — the type comes from the controlled catalogue
 * (`document_type`), so a hand-added row is verifiable, storable and
 * packageable exactly like a generated one. Free-text document names would
 * make "how often do we end up asking for X?" unanswerable, which is the
 * question that tells the business a rule is missing.
 *
 * `is_custom` (0026) is what keeps the two apart for good. Regeneration passes
 * these rows through untouched — no rule produced them, so no rule's absence
 * may withdraw them — and the submission workflow can tell a hand-added
 * document from a generated one when deciding what belongs in a lender's
 * package.
 *
 * PERMISSION: `case.update`, which is what already governs inserting into
 * `document_requirement` (src/domain/permissions/tables.ts). Deliberately NOT
 * `requirement.waive`: adding an ask is an ordinary act of running the case,
 * while excusing one is a decision with a name on it.
 */
export async function addCustomRequirement(
  client: Queryable,
  actor: Actor,
  caseId: string,
  body: AddRequirementInput,
): Promise<RequirementView> {
  const header = await loadCaseHeader(client, caseId);
  requireCaseAccess(actor, header, "case.update");

  const documentTypeCode =
    typeof body.documentTypeCode === "string" ? body.documentTypeCode.trim() : "";
  if (!documentTypeCode) throw new ApiError(400, "Choose a document type.");

  const { rows: typeRows } = await client.query<{ id: string; name: string; is_active: boolean }>(
    `select id, name, is_active from document_type where code = $1`,
    [documentTypeCode],
  );
  const documentType = typeRows[0];
  if (!documentType) throw new ApiError(400, "No such document type.");
  // A deactivated type is one the business has retired. Adding a new ask
  // against it would quietly bring it back, one case at a time.
  if (!documentType.is_active) {
    throw new ApiError(400, "That document type is no longer in use.");
  }

  const casePartyId = typeof body.casePartyId === "string" && body.casePartyId ? body.casePartyId : null;
  const casePropertyId =
    typeof body.casePropertyId === "string" && body.casePropertyId ? body.casePropertyId : null;

  // `document_requirement_subject_is_singular` (0005) would refuse this
  // anyway; the check exists so the refusal reads as a sentence.
  if (casePartyId && casePropertyId) {
    throw new ApiError(400, "A document belongs to a person or to a property, not to both.");
  }

  if (casePartyId) {
    const { rows } = await client.query(
      `select id from case_party where id = $1 and case_id = $2 and removed_at is null`,
      [casePartyId, caseId],
    );
    if (!rows[0]) throw new ApiError(400, "That party is not on this case.");
  }
  if (casePropertyId) {
    const { rows } = await client.query(
      `select id from case_property where id = $1 and case_id = $2 and removed_at is null`,
      [casePropertyId, caseId],
    );
    if (!rows[0]) throw new ApiError(400, "That property is not on this case.");
  }

  const note = typeof body.note === "string" ? body.note.trim() : "";

  const applicability = await client.query<{ id: string }>(
    `select id from requirement_applicability where code = 'mandatory'`,
  );

  const inserted = await client.query<{ id: string }>(
    `insert into document_requirement
       (case_id, document_type_id, required_of_case_party_id, required_of_case_property_id,
        applicable_from_stage, applicability_id, is_custom, custom_name, custom_description,
        created_by)
     values ($1, $2, $3, $4, 'documents_pending', $5, true, $6, $7, $8)
     returning id`,
    [
      caseId,
      documentType.id,
      casePartyId,
      casePropertyId,
      applicability.rows[0]?.id ?? null,
      // `document_requirement_custom_needs_a_name` (0026) requires a name on
      // every custom row. The document type's own name is the honest default:
      // the type IS what is being asked for, and the note explains why.
      documentType.name,
      note.length > 0 ? note : null,
      actor.userId,
    ],
  );
  const requirementId = inserted.rows[0]!.id;

  await recordRequirementAddedEvent(client, {
    actorUserId: actor.userId,
    caseId,
    requirementId,
    payloadAfter: { documentTypeCode, casePartyId, casePropertyId },
  });

  return await requirementView(client, requirementId);
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

export async function downloadDocument(
  client: Queryable,
  actor: Actor,
  documentId: string,
): Promise<{ bytes: Uint8Array; contentType: string; fileName: string }> {
  const { rows } = await client.query<{
    case_id: string | null;
    person_id: string | null;
    organisation_id: string | null;
    property_id: string | null;
    file_path: string;
    file_name: string | null;
  }>(
    `select d.case_id, d.person_id, d.organisation_id, d.property_id, d.file_path, d.file_name,
            coalesce(
              d.case_id,
              (select cpa.case_id from case_party cpa
                where cpa.person_id = d.person_id or cpa.organisation_id = d.organisation_id
                limit 1),
              (select cpr.case_id from case_property cpr where cpr.property_id = d.property_id limit 1)
            ) as resolved_case_id
       from document d
      where d.id = $1`,
    [documentId],
  );
  const row = rows[0] as (typeof rows)[number] & { resolved_case_id: string | null };
  if (!row) throw new ApiError(404, "No such document.");

  // A document belongs to a person, property or organisation, never directly
  // to a case (ADR-007) — access is checked against whichever case it is
  // reachable from, the same way the requirement listing resolves the
  // reverse direction.
  if (row.resolved_case_id) {
    const header = await loadCaseHeader(client, row.resolved_case_id);
    requireCaseAccess(actor, header, "document.read");
  } else if (!can(actor, "document.read", "all")) {
    throw new ApiError(404, "No such document.");
  }

  const object = await getObjectWithContentType(row.file_path);
  return { bytes: object.bytes, contentType: object.contentType, fileName: row.file_name ?? "document" };
}

// ---------------------------------------------------------------------------
// Case readiness — fixing the INPUT to the existing transition guard
// ---------------------------------------------------------------------------

/**
 * After a requirement's status changes, ask the existing transition machine
 * whether the case should move — never a second state machine, never a
 * bypass of `evaluateTransition`. Only the two moves whose guard this
 * milestone can now answer honestly: `documents_pending` -> settled, and the
 * reverse when a rejection re-opens what looked done (ADR-019's backwards
 * move).
 *
 * NOT routed through `advanceCaseStage` (`Backend/case-stage.ts`, Phase 5):
 * that helper's `deriveSystemStagePath` only ever targets `submitted`,
 * `sanctioned` or `disbursed` (`highestJustifiedStage`,
 * `@domain/case/transitions.ts`) — it has no notion of
 * `ready_for_submission` at all, because that stage is not "justified by a
 * submission fact", it is justified by requirements being settled. Routing
 * this function through it would silently stop reconciling documents_pending
 * <-> ready_for_submission, which is exactly the regression a Phase 5
 * integration test caught. `hasSanctionedSubmissionWithOffer` and
 * `hasDisbursedSubmission` stay real (`submissionOutcomeFacts`, shared with
 * `cases.ts` and `submissions.ts`) even though neither guard below reads
 * them, so a future guard change here does not silently see stale zeros.
 */
async function reconcileStage(
  client: Queryable,
  caseId: string,
  causedBy: { entityType: string; entityId: string },
): Promise<void> {
  const header = await loadCaseHeader(client, caseId);
  if (header.isOnHold) return;
  if (header.stage !== "documents_pending" && header.stage !== "ready_for_submission") return;

  const outstanding = await outstandingCountOnly(client, caseId);
  const facts = await submissionOutcomeFacts(client, caseId);
  const snapshot: CaseSnapshot = {
    stage: header.stage,
    outstandingRequirementCount: outstanding,
    liveSubmissionCount: facts.liveSubmissionCount,
    hasSanctionedSubmissionWithOffer: facts.hasSanctionedSubmissionWithOffer,
    hasDisbursedSubmission: facts.hasDisbursedSubmission,
    isInvoiceRaised: false,
    stageBeforeLost: null,
  };

  const candidate: CaseStage =
    header.stage === "documents_pending" ? "ready_for_submission" : "documents_pending";
  const verdict = evaluateTransition(snapshot, { to: candidate, actor: "system" });
  if (!verdict.allowed) return;

  await client.query(`update loan_case set stage = $1 where id = $2`, [candidate, caseId]);
  await recordSystemCaseEvent(client, {
    caseId,
    eventType: "case.stage_changed",
    payloadBefore: { stage: header.stage },
    payloadAfter: { stage: candidate },
    causedByEntityType: causedBy.entityType,
    causedByEntityId: causedBy.entityId,
  });
}

/** The count alone, without the reconciliation side-effect that
 * `outstandingRequirementCount` (Backend/requirements.ts) also performs —
 * `reconcileStage` runs immediately after a write that already regenerated
 * the case's requirements, so a second regeneration here would be redundant
 * work, not a correctness issue, but there is no reason to pay for it twice. */
async function outstandingCountOnly(client: Queryable, caseId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `select count(*) as n from document_requirement
      where case_id = $1 and status in ('pending', 'received', 'rejected')`,
    [caseId],
  );
  return Number(rows[0]?.n ?? 0);
}
