/**
 * Master data administration — document types, rejection reasons, document
 * requirement rules and operational thresholds — server-side.
 *
 * Stage 4 Item 4. UNTIL NOW THESE FOUR TABLES HAD NO WRITE PATH AT ALL:
 * `Backend/reference.ts` and `Backend/requirements.ts` already read
 * `document_type`, `document_requirement_rule` and its conditions straight
 * from Postgres (the real requirement engine has always been Postgres-backed
 * — see `Backend/requirements.ts`'s header), but the only place an employee
 * could EDIT any of the four lived in `Frontend/src/fake/store.ts`, writing
 * to one browser's `localStorage` and invisible to everyone else, including
 * the engine that actually builds a case's checklist. This module is the
 * write path that was missing — nothing here is a second rules engine or a
 * second copy of the data; it is the mutation half of the same rows
 * `Backend/requirements.ts` already reads.
 *
 * PRODUCTS AND LENDERS ARE DELIBERATELY NOT HERE. Stage 4 Item 4 keeps them
 * read-only (`Backend/reference.ts`, `Backend/lenders.ts`) — a product or a
 * lender is a richer entity than a code/name row (ADR-032/033/034) and its
 * own management surface is a later, named piece of work.
 *
 * EVERY MUTATION HERE REQUIRES `master_data.manage` AT SCOPE `all`, held only
 * by `manager`, `admin` and `managing_partner` (migration 0008) — an ordinary
 * employee gets a 403, never a hidden button (BR-060). Every read requires
 * `master_data.read`, held by every role.
 */

import { CASE_STAGE_PROGRESSION, type ProgressionStage } from "@domain/case/stages.js";
import { DOCUMENT_CATEGORIES, type DocumentCategory } from "@domain/requirements/document-catalogue.js";
import { isThresholdKey } from "@domain/settings/thresholds.js";

import type { Queryable } from "./db.js";
import { can, type Actor } from "./authorize.js";
import { ApiError, refusalMessage } from "./http.js";
import { recordMasterDataEvent } from "./events.js";

function requireRead(actor: Actor): void {
  if (!can(actor, "master_data.read", "all")) {
    throw new ApiError(403, refusalMessage("master_data.read"));
  }
}

function requireManage(actor: Actor): void {
  if (!can(actor, "master_data.manage", "all")) {
    throw new ApiError(403, refusalMessage("master_data.manage"));
  }
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Document types
// ---------------------------------------------------------------------------

const DOCUMENT_TYPE_SELECT = `
  select id, code, name, local_name, description, examples, category,
         owner_kind, requires_period, requires_expiry, period_kind,
         is_active, display_order
    from document_type`;

function documentTypeFromRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    localName: row.local_name ?? undefined,
    description: row.description ?? undefined,
    examples: row.examples ?? undefined,
    category: row.category ?? undefined,
    ownerKind: row.owner_kind,
    requiresPeriod: row.requires_period,
    requiresExpiry: row.requires_expiry,
    periodKind: row.period_kind ?? undefined,
    isActive: row.is_active,
    displayOrder: row.display_order,
  };
}

export async function listDocumentTypes(client: Queryable, actor: Actor) {
  requireRead(actor);
  const { rows } = await client.query(`${DOCUMENT_TYPE_SELECT} order by display_order, name`);
  return rows.map(documentTypeFromRow);
}

async function loadDocumentTypeOr404(client: Queryable, id: string) {
  const { rows } = await client.query(`${DOCUMENT_TYPE_SELECT} where id = $1`, [id]);
  if (!rows[0]) throw new ApiError(404, "No such document type.");
  return rows[0] as Record<string, unknown>;
}

/**
 * What a document is CALLED and how it is EXPLAINED — name, local name,
 * description, examples, category. Mirrors exactly the fields
 * `DocumentTypeModal` (`Frontend/src/screens/MasterData.tsx`) has always
 * edited; what kind of thing a document type belongs to (`owner_kind`,
 * `requires_period`, `requires_expiry`) stays a structural, code-only
 * decision the requirement engine depends on — unchanged here, same as the
 * prototype never let it change either.
 */
export async function updateDocumentType(
  client: Queryable,
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  requireManage(actor);
  const before = await loadDocumentTypeOr404(client, id);

  const name = trimmedString(body.name);
  if (!name) throw new ApiError(400, "Name is required.");

  // Fields left out of the patch keep their current value — the same
  // partial-update contract `Frontend/src/fake/store.ts`'s
  // `updateDocumentTypeDetails` always gave ("a patch that never mentions the
  // field leaves it alone"). `category` is `not null` in the schema, so it
  // may never resolve to null even when omitted.
  const localName = "localName" in body ? trimmedString(body.localName) || null : (before.local_name ?? null);
  const description = "description" in body ? trimmedString(body.description) || null : (before.description ?? null);
  const examples: string[] = Array.isArray(body.examples)
    ? body.examples.map((value) => String(value).trim()).filter((value) => value.length > 0)
    : ((before.examples as string[] | null) ?? []);

  let category = before.category as string;
  if ("category" in body) {
    const candidate = trimmedString(body.category);
    if (!candidate || !(DOCUMENT_CATEGORIES as readonly string[]).includes(candidate)) {
      throw new ApiError(400, `Unknown category: ${String(body.category)}.`);
    }
    category = candidate;
  }

  const { rows } = await client.query(
    `update document_type
        set name = $1, local_name = $2, description = $3, examples = $4, category = $5
      where id = $6
      returning *`,
    [name, localName, description, examples.length > 0 ? examples : null, category, id],
  );

  await recordMasterDataEvent(client, {
    actorUserId: actor.userId,
    entityType: "document_type",
    entityId: id,
    eventType: "document_type.updated",
    payloadBefore: { name: before.name, category: before.category },
    payloadAfter: { name, category },
  });

  return documentTypeFromRow(rows[0]);
}

export async function setDocumentTypeActive(
  client: Queryable,
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  requireManage(actor);
  await loadDocumentTypeOr404(client, id);
  const isActive = Boolean(body.isActive);

  const { rows } = await client.query(
    `update document_type set is_active = $1 where id = $2 returning *`,
    [isActive, id],
  );

  await recordMasterDataEvent(client, {
    actorUserId: actor.userId,
    entityType: "document_type",
    entityId: id,
    eventType: isActive ? "document_type.activated" : "document_type.deactivated",
    payloadAfter: { isActive },
  });

  return documentTypeFromRow(rows[0]);
}

// ---------------------------------------------------------------------------
// Rejection reasons (ADR-028)
// ---------------------------------------------------------------------------

const REJECTION_REASON_SELECT = `
  select id, code, name, description, is_active, display_order from rejection_reason`;

function rejectionReasonFromRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? undefined,
    isActive: row.is_active,
    displayOrder: row.display_order,
  };
}

export async function listRejectionReasons(client: Queryable, actor: Actor) {
  requireRead(actor);
  const { rows } = await client.query(`${REJECTION_REASON_SELECT} order by display_order, name`);
  return rows.map(rejectionReasonFromRow);
}

async function loadRejectionReasonOr404(client: Queryable, id: string) {
  const { rows } = await client.query(`${REJECTION_REASON_SELECT} where id = $1`, [id]);
  if (!rows[0]) throw new ApiError(404, "No such rejection reason.");
  return rows[0] as Record<string, unknown>;
}

export async function updateRejectionReason(
  client: Queryable,
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  requireManage(actor);
  const before = await loadRejectionReasonOr404(client, id);

  const name = trimmedString(body.name);
  if (!name) throw new ApiError(400, "Name is required.");
  const description = "description" in body ? trimmedString(body.description) || null : (before.description ?? null);

  const { rows } = await client.query(
    `update rejection_reason set name = $1, description = $2 where id = $3 returning *`,
    [name, description, id],
  );

  await recordMasterDataEvent(client, {
    actorUserId: actor.userId,
    entityType: "rejection_reason",
    entityId: id,
    eventType: "rejection_reason.updated",
    payloadBefore: { name: before.name },
    payloadAfter: { name },
  });

  return rejectionReasonFromRow(rows[0]);
}

export async function setRejectionReasonActive(
  client: Queryable,
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  requireManage(actor);
  await loadRejectionReasonOr404(client, id);
  const isActive = Boolean(body.isActive);

  const { rows } = await client.query(
    `update rejection_reason set is_active = $1 where id = $2 returning *`,
    [isActive, id],
  );

  await recordMasterDataEvent(client, {
    actorUserId: actor.userId,
    entityType: "rejection_reason",
    entityId: id,
    eventType: isActive ? "rejection_reason.activated" : "rejection_reason.deactivated",
    payloadAfter: { isActive },
  });

  return rejectionReasonFromRow(rows[0]);
}

// ---------------------------------------------------------------------------
// Document requirement rules (ADR-035) — the rows Backend/requirements.ts
// evaluates for every real case.
// ---------------------------------------------------------------------------

const RULE_SELECT = `
  select r.id, r.code, r.name, dt.code as document_type_code, r.scope,
         -- Cast off the custom enum array types (case_party_role[],
         -- case_property_role[]): node-postgres only auto-parses array OIDs
         -- it has a registered type parser for, and a custom enum's array OID
         -- is not one of them — without the cast it hands back the wire
         -- format as a literal string ("{applicant,co_applicant}"), not a JS
         -- array.
         r.party_roles::text[] as party_roles, r.party_kind, r.property_roles::text[] as property_roles,
         a.code as applicability_code, r.applicable_from_stage,
         r.financial_years, r.condition_match, r.is_active, r.display_order,
         r.notes
    from document_requirement_rule r
    join document_type dt on dt.id = r.document_type_id
    join requirement_applicability a on a.id = r.applicability_id`;

interface ConditionRow {
  rule_id: string;
  fact: string;
  operator: string;
  values: string[] | null;
}

async function loadConditionsByRule(client: Queryable): Promise<Map<string, ConditionRow[]>> {
  const { rows } = await client.query<ConditionRow>(
    `select rule_id, fact, operator, values from document_requirement_rule_condition order by display_order`,
  );
  const byRule = new Map<string, ConditionRow[]>();
  for (const row of rows) {
    const list = byRule.get(row.rule_id) ?? [];
    list.push(row);
    byRule.set(row.rule_id, list);
  }
  return byRule;
}

function ruleFromRow(row: Record<string, unknown>, conditions: readonly ConditionRow[]) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    documentTypeCode: row.document_type_code,
    scope: row.scope,
    partyRoles: row.party_roles ?? undefined,
    partyKind: row.party_kind ?? undefined,
    propertyRoles: row.property_roles ?? undefined,
    applicability: row.applicability_code,
    applicableFromStage: row.applicable_from_stage,
    financialYears: row.financial_years ?? undefined,
    conditions: conditions.map((condition) => ({
      fact: condition.fact,
      operator: condition.operator,
      values: condition.values ?? undefined,
    })),
    match: row.condition_match,
    isActive: row.is_active,
    displayOrder: row.display_order,
    notes: row.notes ?? undefined,
  };
}

export async function listDocumentRequirementRules(client: Queryable, actor: Actor) {
  requireRead(actor);
  const { rows } = await client.query(`${RULE_SELECT} order by r.display_order, r.code`);
  const conditionsByRule = await loadConditionsByRule(client);
  return rows.map((row: Record<string, unknown>) =>
    ruleFromRow(row, conditionsByRule.get(row.id as string) ?? []),
  );
}

async function loadRuleOr404(client: Queryable, id: string) {
  const { rows } = await client.query(`${RULE_SELECT} where r.id = $1`, [id]);
  if (!rows[0]) throw new ApiError(404, "No such document requirement rule.");
  return rows[0] as Record<string, unknown>;
}

const APPLICABILITY_CODES = ["mandatory", "optional", "not_applicable"] as const;

/**
 * The four fields `DocumentRules.tsx`'s edit form has always exposed: how
 * strongly the document is wanted, when it becomes due, how many financial
 * years, and why the rule exists. CONDITIONS ARE NOT EDITED HERE — same
 * deliberate boundary the frontend comment gives: changing when a rule fires
 * is a different decision from changing what it asks for.
 */
export async function updateDocumentRequirementRule(
  client: Queryable,
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  requireManage(actor);
  const before = await loadRuleOr404(client, id);

  const name = trimmedString(body.name);
  if (!name) throw new ApiError(400, "Name is required.");

  const applicability = trimmedString(body.applicability);
  if (!applicability || !(APPLICABILITY_CODES as readonly string[]).includes(applicability)) {
    throw new ApiError(400, "Applicability must be mandatory, optional or not_applicable.");
  }

  const applicableFromStage = trimmedString(body.applicableFromStage);
  if (
    !applicableFromStage ||
    !(CASE_STAGE_PROGRESSION as readonly string[]).includes(applicableFromStage)
  ) {
    throw new ApiError(400, "Unknown stage.");
  }

  let financialYears: number | null = null;
  if (body.financialYears !== undefined && body.financialYears !== null && body.financialYears !== "") {
    const parsed = Number(body.financialYears);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
      throw new ApiError(400, "Financial years must be a whole number from 1 to 10.");
    }
    financialYears = parsed;
  }

  const notes = trimmedString(body.notes) || null;

  const { rows: applicabilityRows } = await client.query(
    `select id from requirement_applicability where code = $1`,
    [applicability],
  );
  const applicabilityId = applicabilityRows[0]?.id;
  if (!applicabilityId) throw new ApiError(400, `Unknown applicability: ${applicability}.`);

  await client.query(
    `update document_requirement_rule
        set name = $1, applicability_id = $2, applicable_from_stage = $3,
            financial_years = $4, notes = $5
      where id = $6`,
    [name, applicabilityId, applicableFromStage as ProgressionStage, financialYears, notes, id],
  );

  await recordMasterDataEvent(client, {
    actorUserId: actor.userId,
    entityType: "document_requirement_rule",
    entityId: id,
    eventType: "requirement_rule.updated",
    payloadBefore: {
      applicability: before.applicability_code,
      applicableFromStage: before.applicable_from_stage,
      financialYears: before.financial_years,
    },
    payloadAfter: { applicability, applicableFromStage, financialYears },
  });

  const after = await loadRuleOr404(client, id);
  const conditionsByRule = await loadConditionsByRule(client);
  return ruleFromRow(after, conditionsByRule.get(id) ?? []);
}

export async function setDocumentRequirementRuleActive(
  client: Queryable,
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  requireManage(actor);
  await loadRuleOr404(client, id);
  const isActive = Boolean(body.isActive);

  await client.query(`update document_requirement_rule set is_active = $1 where id = $2`, [
    isActive,
    id,
  ]);

  await recordMasterDataEvent(client, {
    actorUserId: actor.userId,
    entityType: "document_requirement_rule",
    entityId: id,
    eventType: isActive ? "requirement_rule.activated" : "requirement_rule.deactivated",
    payloadAfter: { isActive },
  });

  const after = await loadRuleOr404(client, id);
  const conditionsByRule = await loadConditionsByRule(client);
  return ruleFromRow(after, conditionsByRule.get(id) ?? []);
}

// ---------------------------------------------------------------------------
// Operational thresholds (ADR-025) — the value is business-editable, the key
// set is not (@domain/settings/thresholds.ts).
// ---------------------------------------------------------------------------

function thresholdFromRow(row: Record<string, unknown>) {
  return {
    key: row.key,
    valueDays: row.value_days,
    description: row.description ?? undefined,
    updatedBy: row.updated_by ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  };
}

export async function listThresholds(client: Queryable, actor: Actor) {
  requireRead(actor);
  const { rows } = await client.query(
    `select key, value_days, description, updated_by, updated_at
       from operational_threshold order by key`,
  );
  return rows.map(thresholdFromRow);
}

export async function updateThreshold(
  client: Queryable,
  actor: Actor,
  key: string,
  body: Record<string, unknown>,
) {
  requireManage(actor);
  if (!isThresholdKey(key)) throw new ApiError(404, "No such threshold.");

  const { rows: existingRows } = await client.query(
    `select value_days from operational_threshold where key = $1`,
    [key],
  );
  if (!existingRows[0]) throw new ApiError(404, "No such threshold.");

  const valueDays = Number(body.valueDays);
  if (!Number.isInteger(valueDays) || valueDays <= 0) {
    throw new ApiError(400, "Value must be a positive whole number of days.");
  }

  const { rows } = await client.query(
    `update operational_threshold
        set value_days = $1, updated_by = $2, updated_at = now()
      where key = $3
      returning key, value_days, description, updated_by, updated_at`,
    [valueDays, actor.userId, key],
  );

  await recordMasterDataEvent(client, {
    actorUserId: actor.userId,
    entityType: "operational_threshold",
    entityId: null,
    eventType: "threshold.updated",
    payloadBefore: { key, valueDays: existingRows[0].value_days },
    payloadAfter: { key, valueDays },
  });

  return thresholdFromRow(rows[0]);
}
