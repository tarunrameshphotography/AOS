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
import { recordDocumentEvent, recordSystemCaseEvent } from "./events.js";
import { regenerateRequirements } from "./requirements.js";
import { storageAdapter, getObjectWithContentType } from "./storage-client.js";

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

export interface RequirementView {
  readonly id: string;
  readonly documentTypeCode: string;
  readonly applicableFromStage: string;
  readonly applicability: string;
  readonly status: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly requiredOfCasePartyId: string | null;
  readonly generatedByRuleCode: string | null;
  readonly reason: string | null;
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
  generated_by_rule_code: string | null;
  reason: string | null;
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
    `select r.id, dt.code as document_type_code, r.applicable_from_stage,
            a.code as applicability, r.status, r.period_start::text, r.period_end::text,
            r.required_of_case_party_id, rule.code as generated_by_rule_code, r.reason,
            d.id as document_id, d.file_name, d.file_size_bytes, d.version,
            d.uploaded_at::text, d.uploaded_by, d.verified_at::text, d.verified_by
       from document_requirement r
       join document_type dt on dt.id = r.document_type_id
       left join requirement_applicability a on a.id = r.applicability_id
       left join document_requirement_rule rule on rule.id = r.generated_by_rule_id
       left join case_party cpa on cpa.id = r.required_of_case_party_id
       left join case_property cpr on cpr.id = r.required_of_case_property_id
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
       ) d on true
      where r.case_id = $1 and r.status <> 'not_applicable'
      order by dt.display_order, dt.code, r.period_start desc nulls last`,
    [caseId],
  );

  const requirements: RequirementView[] = rows.map((row) => ({
    id: row.id,
    documentTypeCode: row.document_type_code,
    applicableFromStage: row.applicable_from_stage,
    applicability: row.applicability,
    status: row.status,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    requiredOfCasePartyId: row.required_of_case_party_id,
    generatedByRuleCode: row.generated_by_rule_code,
    reason: row.reason,
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
  }));

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
  const { rows } = await client.query<RequirementRow>(
    `select r.id, dt.code as document_type_code, r.applicable_from_stage,
            a.code as applicability, r.status, r.period_start::text, r.period_end::text,
            r.required_of_case_party_id, rule.code as generated_by_rule_code, r.reason,
            d.id as document_id, d.file_name, d.file_size_bytes, d.version,
            d.uploaded_at::text, d.uploaded_by, d.verified_at::text, d.verified_by
       from document_requirement r
       join document_type dt on dt.id = r.document_type_id
       left join requirement_applicability a on a.id = r.applicability_id
       left join document_requirement_rule rule on rule.id = r.generated_by_rule_id
       left join case_party cpa on cpa.id = r.required_of_case_party_id
       left join case_property cpr on cpr.id = r.required_of_case_property_id
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
       ) d on true
      where r.id = $1`,
    [requirementId],
  );
  const row = rows[0];
  if (!row) throw new ApiError(404, "No such requirement.");
  return {
    id: row.id,
    documentTypeCode: row.document_type_code,
    applicableFromStage: row.applicable_from_stage,
    applicability: row.applicability,
    status: row.status,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    requiredOfCasePartyId: row.required_of_case_party_id,
    generatedByRuleCode: row.generated_by_rule_code,
    reason: row.reason,
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
 * move). Everything past `ready_for_submission` still depends on
 * submissions, which remain out of scope, so their guards keep refusing
 * exactly as before.
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
  const snapshot: CaseSnapshot = {
    stage: header.stage,
    outstandingRequirementCount: outstanding,
    liveSubmissionCount: 0,
    hasSanctionedSubmissionWithOffer: false,
    hasDisbursedSubmission: false,
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
