/**
 * Case parties and case properties — Phase 4 (Case Completeness).
 *
 * `case_party` and `case_property` have existed since migration 0004, and the
 * requirement engine has read them since migration 0021 (`loadCaseFacts`,
 * `Backend/requirements.ts`) — a rule scoped `party` or `property` already
 * evaluates once per role that actually exists on a case. What has been
 * missing is a way to CREATE that composition: until this file, a case could
 * be born with a primary applicant and nothing else could ever be added.
 * `Backend/cases.ts`'s own header said as much: "Case parties beyond the
 * primary applicant, and case properties, go with [documents/requirements] —
 * they exist to feed the requirement engine, which has not moved." It has
 * moved; this is where they land.
 *
 * NO SCHEMA CHANGE. `case_party.employment_type_id` / `borrower_type_id` /
 * `business_constitution_id` (0021) are case-specific overrides of a shared
 * person/organisation record, never a rewrite of it — the same reasoning
 * `Frontend/src/fake/store.ts`'s `updatePartyProfile` documents. `property`
 * (0003) already carries every field a login desk records about a security;
 * `case_property.role` (`collateral` / `purchase` / `both`) is the only new
 * fact this milestone writes anywhere.
 *
 * PERMISSIONS ARE NOT NEW EITHER (`src/domain/permissions/tables.ts` already
 * binds `case_party` and `case_property`'s insert/update to `case.update`,
 * written down at the same moment the tables were — see its comment "case_party
 * is governed by case.read / case.update"). Attaching an EXISTING person or
 * property needs only `case.update`. Creating a genuinely new person or
 * property inline additionally needs `person.create` / `property.create` —
 * the permission that already governs writing to those tables directly, and
 * a Telecaller does not hold `property.create`, so a Telecaller can attach a
 * property someone else already recorded but cannot invent one on a case —
 * exactly the shape the role grid already draws.
 *
 * WAIVING requirements is not here — `document_requirement`'s update is
 * shared between `case.update`, `document.verify` and `requirement.waive`
 * (`tables.ts`), and the waive action itself lives in `Backend/documents.ts`
 * next to `decideDocument`, which already owns every other
 * `document_requirement` status transition.
 *
 * REQUIREMENTS ARE NOT REGENERATED HERE. `regenerateRequirements`
 * (`Backend/requirements.ts`) already runs on every read of a case's
 * requirements (Phase 3 kept that architecture deliberately) — adding,
 * editing or removing a party or property changes the CaseFacts the rule
 * engine reads next time `listCaseRequirements` runs, and that is the one
 * place regeneration happens. A second explicit regeneration call here would
 * duplicate that reconciliation, not improve it.
 */

import type { Queryable } from "./db.js";
import { can, canActOnCase, type Actor } from "./authorize.js";
import { recordCasePartyEvent, recordCasePropertyEvent } from "./events.js";
import { ApiError, refusalMessage } from "./http.js";

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === UNIQUE_VIOLATION;
}

/** 404 rather than 403 — matches `Backend/cases.ts`'s `notFound()`: a
 * Telecaller probing another case's party list learns nothing from the
 * difference between "does not exist" and "not yours". */
function notFound(): ApiError {
  return new ApiError(404, "No such case, or you do not have access to it.");
}

interface CaseHeader {
  readonly id: string;
  readonly ownerUserId: string;
}

async function loadCaseHeader(client: Queryable, actor: Actor, caseId: string): Promise<CaseHeader> {
  const { rows } = await client.query(`select id, owner_user_id from loan_case where id = $1`, [caseId]);
  const row = rows[0];
  if (!row) throw notFound();
  if (!canActOnCase(actor, row.owner_user_id, "case.read")) throw notFound();
  return { id: row.id, ownerUserId: row.owner_user_id };
}

function requireCaseUpdate(actor: Actor, header: CaseHeader): void {
  if (!canActOnCase(actor, header.ownerUserId, "case.update")) {
    throw new ApiError(403, refusalMessage("case.update"));
  }
}

// ---------------------------------------------------------------------------
// Case parties
// ---------------------------------------------------------------------------

const ADDABLE_PARTY_ROLES = ["co_applicant", "guarantor", "referrer", "borrower_firm"] as const;
type AddablePartyRole = (typeof ADDABLE_PARTY_ROLES)[number];

export interface CasePartyView {
  readonly id: string;
  readonly caseId: string;
  readonly personId: string | null;
  readonly organisationId: string | null;
  readonly name: string | null;
  readonly role: string;
  readonly isPrimary: boolean;
  readonly employmentTypeId: string | null;
  readonly borrowerTypeId: string | null;
  readonly businessConstitutionId: string | null;
  readonly removedAt: string | null;
  readonly createdAt: string;
}

const PARTY_COLUMNS = `
  cpa.id, cpa.case_id, cpa.person_id, cpa.organisation_id, cpa.role, cpa.is_primary,
  cpa.employment_type_id, cpa.borrower_type_id, cpa.business_constitution_id,
  cpa.removed_at::text, cpa.created_at::text,
  coalesce(p.full_name, o.canonical_name) as name`;

function partyFromRow(row: Record<string, unknown>): CasePartyView {
  return {
    id: row.id as string,
    caseId: row.case_id as string,
    personId: (row.person_id as string | null) ?? null,
    organisationId: (row.organisation_id as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    role: row.role as string,
    isPrimary: row.is_primary === true,
    employmentTypeId: (row.employment_type_id as string | null) ?? null,
    borrowerTypeId: (row.borrower_type_id as string | null) ?? null,
    businessConstitutionId: (row.business_constitution_id as string | null) ?? null,
    removedAt: (row.removed_at as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

/** Every party on a case, including removed ones — the timeline needs to
 * show that a co-applicant was once here, not just that one is not now
 * (`case_party.removed_at`'s own comment: "the fact that the case once had a
 * co-applicant is what the timeline is for"). */
export async function listCaseParties(client: Queryable, actor: Actor, caseId: string): Promise<CasePartyView[]> {
  await loadCaseHeader(client, actor, caseId);

  const { rows } = await client.query(
    `select ${PARTY_COLUMNS}
       from case_party cpa
       left join person p on p.id = cpa.person_id
       left join organisation o on o.id = cpa.organisation_id
      where cpa.case_id = $1
      order by cpa.is_primary desc, cpa.created_at`,
    [caseId],
  );
  return rows.map(partyFromRow);
}

export interface AddCasePartyInput {
  role?: unknown;
  personId?: unknown;
  organisationId?: unknown;
  newPersonName?: unknown;
  newPersonPhone?: unknown;
  newOrganisationName?: unknown;
}

/**
 * Attach a co-applicant, guarantor, referrer or borrowing firm to a case.
 *
 * The primary applicant is not addable here — it is set once, at case
 * creation (`createCase`, `Backend/cases.ts`), and `case_party_primary_is_applicant`
 * plus `case_party_one_primary_applicant` (0004) both assume there is exactly
 * one and it never arrives through this path.
 */
export async function addCaseParty(
  client: Queryable,
  actor: Actor,
  caseId: string,
  body: AddCasePartyInput,
): Promise<CasePartyView> {
  const header = await loadCaseHeader(client, actor, caseId);
  requireCaseUpdate(actor, header);

  const role = typeof body.role === "string" ? body.role : "";
  if (!(ADDABLE_PARTY_ROLES as readonly string[]).includes(role)) {
    throw new ApiError(400, `A party's role must be one of: ${ADDABLE_PARTY_ROLES.join(", ")}.`);
  }
  const partyRole = role as AddablePartyRole;

  let personId = typeof body.personId === "string" && body.personId ? body.personId : null;
  let organisationId =
    typeof body.organisationId === "string" && body.organisationId ? body.organisationId : null;

  if (partyRole === "borrower_firm" && personId) {
    throw new ApiError(400, "A borrowing firm must be an organisation, not a person.");
  }
  if (partyRole !== "borrower_firm" && organisationId) {
    throw new ApiError(400, "Only a borrowing firm may be an organisation.");
  }

  if (!personId && !organisationId) {
    const newPersonName = typeof body.newPersonName === "string" ? body.newPersonName.trim() : "";
    const newOrganisationName =
      typeof body.newOrganisationName === "string" ? body.newOrganisationName.trim() : "";

    if (partyRole === "borrower_firm") {
      if (!newOrganisationName) throw new ApiError(400, "Pick an organisation, or name a new one.");
      if (!can(actor, "organisation.create", "all")) {
        throw new ApiError(403, refusalMessage("organisation.create"));
      }
      const inserted = await client.query<{ id: string }>(
        `insert into organisation (canonical_name, created_by) values ($1, $2) returning id`,
        [newOrganisationName, actor.userId],
      );
      organisationId = inserted.rows[0]!.id;
    } else {
      if (!newPersonName) throw new ApiError(400, "Pick a person, or name a new one.");
      if (!can(actor, "person.create", "all")) {
        throw new ApiError(403, refusalMessage("person.create"));
      }
      const inserted = await client.query<{ id: string }>(
        `insert into person (full_name, created_by) values ($1, $2) returning id`,
        [newPersonName, actor.userId],
      );
      personId = inserted.rows[0]!.id;

      const phone = typeof body.newPersonPhone === "string" ? body.newPersonPhone.trim() : "";
      if (phone.length > 0) {
        await client.query(
          `insert into person_identifier
             (person_id, identifier_type, value_raw, value_normalised, is_primary, created_by)
           values ($1, 'phone', $2, $3, true, $4)`,
          [personId, phone, phone.replace(/\D/g, ""), actor.userId],
        );
      }
    }
  } else if (personId) {
    const exists = await client.query(`select id from person where id = $1`, [personId]);
    if (!exists.rows[0]) throw new ApiError(400, "No such person.");
  } else if (organisationId) {
    const exists = await client.query(`select id from organisation where id = $1`, [organisationId]);
    if (!exists.rows[0]) throw new ApiError(400, "No such organisation.");
  }

  let inserted;
  try {
    inserted = await client.query<{ id: string }>(
      `insert into case_party (case_id, person_id, organisation_id, role, is_primary, created_by)
       values ($1, $2, $3, $4, false, $5)
       returning id`,
      [caseId, personId, organisationId, partyRole, actor.userId],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "That person or organisation already holds this role on the case.");
    }
    throw error;
  }
  const casePartyId = inserted.rows[0]!.id;

  await recordCasePartyEvent(client, {
    actorUserId: actor.userId,
    caseId,
    casePartyId,
    eventType: "case.party_added",
    payloadAfter: { role: partyRole, personId, organisationId },
  });

  return await readCaseParty(client, casePartyId);
}

async function readCaseParty(client: Queryable, casePartyId: string): Promise<CasePartyView> {
  const { rows } = await client.query(
    `select ${PARTY_COLUMNS}
       from case_party cpa
       left join person p on p.id = cpa.person_id
       left join organisation o on o.id = cpa.organisation_id
      where cpa.id = $1`,
    [casePartyId],
  );
  const row = rows[0];
  if (!row) throw new ApiError(404, "No such party.");
  return partyFromRow(row);
}

export interface UpdateCasePartyInput {
  employmentTypeId?: unknown;
  borrowerTypeId?: unknown;
  businessConstitutionId?: unknown;
}

/**
 * Record how a party is being underwritten ON THIS CASE — never a rewrite of
 * the shared person/organisation record (see file header). Mirrors
 * `Frontend/src/fake/store.ts`'s `updatePartyProfile`.
 */
export async function updateCasePartyProfile(
  client: Queryable,
  actor: Actor,
  caseId: string,
  casePartyId: string,
  body: UpdateCasePartyInput,
): Promise<CasePartyView> {
  const header = await loadCaseHeader(client, actor, caseId);
  requireCaseUpdate(actor, header);

  const current = await client.query(
    `select id, employment_type_id, borrower_type_id, business_constitution_id
       from case_party where id = $1 and case_id = $2 and removed_at is null`,
    [casePartyId, caseId],
  );
  if (!current.rows[0]) throw new ApiError(404, "That party is not on this case.");

  const FIELDS: Record<string, { column: string; table: string }> = {
    employmentTypeId: { column: "employment_type_id", table: "employment_type" },
    borrowerTypeId: { column: "borrower_type_id", table: "borrower_type" },
    businessConstitutionId: { column: "business_constitution_id", table: "business_constitution" },
  };

  const sets: string[] = [];
  const values: unknown[] = [];
  const changed: string[] = [];

  for (const [field, { column, table }] of Object.entries(FIELDS)) {
    if (body[field as keyof UpdateCasePartyInput] === undefined) continue;
    const raw = body[field as keyof UpdateCasePartyInput];
    const wanted = raw === "" || raw === null ? null : String(raw);
    if (wanted !== null) {
      // eslint-disable-next-line no-await-in-loop -- a handful of small
      // lookups per request, not a hot path.
      const exists = await client.query(`select id from ${table} where id = $1`, [wanted]);
      if (!exists.rows[0]) throw new ApiError(400, `No such ${table.replace(/_/g, " ")}.`);
    }
    if (current.rows[0][column] === wanted) continue;
    values.push(wanted);
    sets.push(`${column} = $${values.length}`);
    changed.push(field);
  }

  if (sets.length === 0) return await readCaseParty(client, casePartyId);

  values.push(casePartyId);
  await client.query(`update case_party set ${sets.join(", ")} where id = $${values.length}`, values);

  await recordCasePartyEvent(client, {
    actorUserId: actor.userId,
    caseId,
    casePartyId,
    eventType: "case.party_profile_updated",
    payloadAfter: { changedFields: changed },
  });

  return await readCaseParty(client, casePartyId);
}

/**
 * Take a party off the case. The person/organisation record survives — they
 * may be on other cases — and so does the `case_party` row: it gets
 * `removed_at`/`removed_by`, never a delete (0004's own comment). Their
 * requirements become `not_applicable` the next time the case's requirements
 * are read, through the ordinary regeneration path (see file header).
 */
export async function removeCaseParty(
  client: Queryable,
  actor: Actor,
  caseId: string,
  casePartyId: string,
): Promise<void> {
  const header = await loadCaseHeader(client, actor, caseId);
  requireCaseUpdate(actor, header);

  const current = await client.query<{ id: string; is_primary: boolean; role: string }>(
    `select id, is_primary, role from case_party where id = $1 and case_id = $2 and removed_at is null`,
    [casePartyId, caseId],
  );
  const row = current.rows[0];
  if (!row) throw new ApiError(404, "That party is not on this case.");
  if (row.is_primary) {
    throw new ApiError(409, "The primary applicant cannot be removed from a case.");
  }

  await client.query(
    `update case_party set removed_at = now(), removed_by = $1 where id = $2`,
    [actor.userId, casePartyId],
  );

  await recordCasePartyEvent(client, {
    actorUserId: actor.userId,
    caseId,
    casePartyId,
    eventType: "case.party_removed",
    payloadAfter: { role: row.role },
  });
}

// ---------------------------------------------------------------------------
// Case properties
// ---------------------------------------------------------------------------

const CASE_PROPERTY_ROLES = ["collateral", "purchase", "both"] as const;

export interface CasePropertyView {
  readonly id: string;
  readonly caseId: string;
  readonly propertyId: string;
  readonly role: string;
  readonly removedAt: string | null;
  readonly createdAt: string;
  readonly doorNumber: string | null;
  readonly buildingName: string | null;
  readonly locality: string | null;
  readonly city: string | null;
  readonly pincode: string | null;
  readonly propertyTypeId: string | null;
  readonly propertyOwnershipTypeId: string | null;
  readonly areaSqft: number | null;
  readonly estimatedValue: number | null;
  readonly ownershipStatus: string | null;
  readonly surveyNumber: string | null;
  readonly registrationNumber: string | null;
}

const PROPERTY_COLUMNS = `
  cpr.id, cpr.case_id, cpr.property_id, cpr.role, cpr.removed_at::text, cpr.created_at::text,
  p.door_number, p.building_name, p.locality, p.city, p.pincode,
  p.property_type_id, p.property_ownership_type_id,
  p.area_sqft, p.estimated_value, p.ownership_status, p.survey_number, p.registration_number`;

function propertyFromRow(row: Record<string, unknown>): CasePropertyView {
  return {
    id: row.id as string,
    caseId: row.case_id as string,
    propertyId: row.property_id as string,
    role: row.role as string,
    removedAt: (row.removed_at as string | null) ?? null,
    createdAt: row.created_at as string,
    doorNumber: (row.door_number as string | null) ?? null,
    buildingName: (row.building_name as string | null) ?? null,
    locality: (row.locality as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    pincode: (row.pincode as string | null) ?? null,
    propertyTypeId: (row.property_type_id as string | null) ?? null,
    propertyOwnershipTypeId: (row.property_ownership_type_id as string | null) ?? null,
    areaSqft: row.area_sqft === null || row.area_sqft === undefined ? null : Number(row.area_sqft),
    estimatedValue:
      row.estimated_value === null || row.estimated_value === undefined ? null : Number(row.estimated_value),
    ownershipStatus: (row.ownership_status as string | null) ?? null,
    surveyNumber: (row.survey_number as string | null) ?? null,
    registrationNumber: (row.registration_number as string | null) ?? null,
  };
}

export async function listCaseProperties(
  client: Queryable,
  actor: Actor,
  caseId: string,
): Promise<CasePropertyView[]> {
  await loadCaseHeader(client, actor, caseId);

  const { rows } = await client.query(
    `select ${PROPERTY_COLUMNS}
       from case_property cpr
       join property p on p.id = cpr.property_id
      where cpr.case_id = $1
      order by cpr.created_at`,
    [caseId],
  );
  return rows.map(propertyFromRow);
}

async function readCaseProperty(client: Queryable, casePropertyId: string): Promise<CasePropertyView> {
  const { rows } = await client.query(
    `select ${PROPERTY_COLUMNS}
       from case_property cpr
       join property p on p.id = cpr.property_id
      where cpr.id = $1`,
    [casePropertyId],
  );
  const row = rows[0];
  if (!row) throw new ApiError(404, "No such property on this case.");
  return propertyFromRow(row);
}

export interface AddCasePropertyInput {
  role?: unknown;
  propertyId?: unknown;
  locality?: unknown;
  city?: unknown;
  doorNumber?: unknown;
  buildingName?: unknown;
  pincode?: unknown;
  propertyTypeId?: unknown;
}

/**
 * Attach a property to a case — an existing `property` row, or a genuinely
 * new one recorded inline. Mirrors `Frontend/src/fake/store.ts`'s
 * `addCaseProperty`.
 */
export async function addCaseProperty(
  client: Queryable,
  actor: Actor,
  caseId: string,
  body: AddCasePropertyInput,
): Promise<CasePropertyView> {
  const header = await loadCaseHeader(client, actor, caseId);
  requireCaseUpdate(actor, header);

  const role = typeof body.role === "string" ? body.role : "";
  if (!(CASE_PROPERTY_ROLES as readonly string[]).includes(role)) {
    throw new ApiError(400, `A property's role must be one of: ${CASE_PROPERTY_ROLES.join(", ")}.`);
  }

  let propertyId = typeof body.propertyId === "string" && body.propertyId ? body.propertyId : null;

  if (propertyId) {
    const exists = await client.query(`select id from property where id = $1`, [propertyId]);
    if (!exists.rows[0]) throw new ApiError(400, "No such property.");
  } else {
    const locality = typeof body.locality === "string" ? body.locality.trim() : "";
    if (!locality) {
      throw new ApiError(400, "A new property needs at least a locality to be findable later.");
    }
    if (!can(actor, "property.create", "all")) {
      throw new ApiError(403, refusalMessage("property.create"));
    }
    const propertyTypeId =
      typeof body.propertyTypeId === "string" && body.propertyTypeId ? body.propertyTypeId : null;
    if (propertyTypeId) {
      const exists = await client.query(`select id from property_type where id = $1`, [propertyTypeId]);
      if (!exists.rows[0]) throw new ApiError(400, "No such property type.");
    }

    const inserted = await client.query<{ id: string }>(
      `insert into property (door_number, building_name, locality, city, pincode, property_type_id, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [
        typeof body.doorNumber === "string" && body.doorNumber ? body.doorNumber.trim() : null,
        typeof body.buildingName === "string" && body.buildingName ? body.buildingName.trim() : null,
        locality,
        typeof body.city === "string" && body.city ? body.city.trim() : null,
        typeof body.pincode === "string" && body.pincode ? body.pincode.trim() : null,
        propertyTypeId,
        actor.userId,
      ],
    );
    propertyId = inserted.rows[0]!.id;
  }

  let inserted;
  try {
    inserted = await client.query<{ id: string }>(
      `insert into case_property (case_id, property_id, role, created_by)
       values ($1, $2, $3, $4)
       returning id`,
      [caseId, propertyId, role, actor.userId],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "That property is already on this case.");
    }
    throw error;
  }
  const casePropertyId = inserted.rows[0]!.id;

  await recordCasePropertyEvent(client, {
    actorUserId: actor.userId,
    caseId,
    casePropertyId,
    eventType: "case.property_added",
    payloadAfter: { role, propertyId },
  });

  return await readCaseProperty(client, casePropertyId);
}

export interface UpdateCasePropertyInput {
  role?: unknown;
  locality?: unknown;
  city?: unknown;
  doorNumber?: unknown;
  buildingName?: unknown;
  pincode?: unknown;
  propertyTypeId?: unknown;
  propertyOwnershipTypeId?: unknown;
  areaSqft?: unknown;
  estimatedValue?: unknown;
  ownershipStatus?: unknown;
  surveyNumber?: unknown;
  registrationNumber?: unknown;
}

const PROPERTY_FIELD_COLUMNS: Record<string, string> = {
  locality: "locality",
  city: "city",
  doorNumber: "door_number",
  buildingName: "building_name",
  pincode: "pincode",
  propertyTypeId: "property_type_id",
  propertyOwnershipTypeId: "property_ownership_type_id",
  areaSqft: "area_sqft",
  estimatedValue: "estimated_value",
  ownershipStatus: "ownership_status",
  surveyNumber: "survey_number",
  registrationNumber: "registration_number",
};

/**
 * Correct a property already on the case: its role on this case (`case.update`),
 * and/or the underlying property record's own fields (`property.update`) —
 * two different permissions because they are two different facts, exactly as
 * `Backend/case-composition.ts`'s header explains for `case_party`.
 */
export async function updateCaseProperty(
  client: Queryable,
  actor: Actor,
  caseId: string,
  casePropertyId: string,
  body: UpdateCasePropertyInput,
): Promise<CasePropertyView> {
  const header = await loadCaseHeader(client, actor, caseId);

  const current = await client.query<{ id: string; property_id: string; role: string }>(
    `select id, property_id, role from case_property
      where id = $1 and case_id = $2 and removed_at is null`,
    [casePropertyId, caseId],
  );
  const link = current.rows[0];
  if (!link) throw new ApiError(404, "That property is not on this case.");

  const wantsRoleChange = typeof body.role === "string" && body.role !== link.role;
  const wantsFieldChange = Object.keys(PROPERTY_FIELD_COLUMNS).some(
    (field) => body[field as keyof UpdateCasePropertyInput] !== undefined,
  );

  if (wantsRoleChange) requireCaseUpdate(actor, header);
  if (wantsFieldChange && !can(actor, "property.update", "all")) {
    throw new ApiError(403, refusalMessage("property.update"));
  }

  const changed: string[] = [];

  if (wantsRoleChange) {
    const role = String(body.role);
    if (!(CASE_PROPERTY_ROLES as readonly string[]).includes(role)) {
      throw new ApiError(400, `A property's role must be one of: ${CASE_PROPERTY_ROLES.join(", ")}.`);
    }
    await client.query(`update case_property set role = $1 where id = $2`, [role, casePropertyId]);
    changed.push("role");
  }

  if (wantsFieldChange) {
    const propertyRow = await client.query(
      `select ${Object.values(PROPERTY_FIELD_COLUMNS).join(", ")} from property where id = $1`,
      [link.property_id],
    );
    const propertyCurrent = propertyRow.rows[0];

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [field, column] of Object.entries(PROPERTY_FIELD_COLUMNS)) {
      const raw = body[field as keyof UpdateCasePropertyInput];
      if (raw === undefined) continue;
      const wanted = raw === "" ? null : raw;
      if (String(propertyCurrent?.[column] ?? "") === String(wanted ?? "")) continue;
      values.push(wanted);
      sets.push(`${column} = $${values.length}`);
      changed.push(field);
    }
    if (sets.length > 0) {
      values.push(link.property_id);
      await client.query(`update property set ${sets.join(", ")} where id = $${values.length}`, values);
    }
  }

  if (changed.length === 0) return await readCaseProperty(client, casePropertyId);

  await recordCasePropertyEvent(client, {
    actorUserId: actor.userId,
    caseId,
    casePropertyId,
    eventType: "case.property_updated",
    payloadAfter: { changedFields: changed },
  });

  return await readCaseProperty(client, casePropertyId);
}

/**
 * Take a property off the case. The property record survives — it may be on
 * another case (ADR-007) — and so does the `case_property` link, marked
 * `removed_at`. Its requirements retire to `not_applicable` the next time the
 * case's requirements are read.
 */
export async function removeCaseProperty(
  client: Queryable,
  actor: Actor,
  caseId: string,
  casePropertyId: string,
): Promise<void> {
  const header = await loadCaseHeader(client, actor, caseId);
  requireCaseUpdate(actor, header);

  const current = await client.query<{ id: string; role: string }>(
    `select id, role from case_property where id = $1 and case_id = $2 and removed_at is null`,
    [casePropertyId, caseId],
  );
  const row = current.rows[0];
  if (!row) throw new ApiError(404, "That property is not on this case.");

  await client.query(
    `update case_property set removed_at = now(), removed_by = $1 where id = $2`,
    [actor.userId, casePropertyId],
  );

  await recordCasePropertyEvent(client, {
    actorUserId: actor.userId,
    caseId,
    casePropertyId,
    eventType: "case.property_removed",
    payloadAfter: { role: row.role },
  });
}
