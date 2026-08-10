/**
 * Customers — the `person` table — server-side.
 *
 * Moved out of `api-server.ts` in Stage 3B and widened at the same time. Stage
 * 2 proved the architecture with a deliberately thin slice: name, address,
 * dates. That was enough to answer "does persistence work", and not nearly
 * enough to render the screens. `PersonProfile` shows phone and PAN in its
 * header, the global search matches on identifiers and aliases, and the
 * person picker on the new-case form ranks candidates by phone — none of
 * which the Stage 2 shape could answer.
 *
 * So identifiers and aliases come across here. They are not a new feature:
 * `person_identifier` and `person_alias` have existed since migration 0002,
 * and the frontend prototype has read equivalents off its in-memory `Person`
 * since the beginning. This is the slice catching up to what the UI already
 * shows, which is the difference between migrating a screen and quietly
 * dropping half of it.
 *
 * WHAT IS STILL NOT HERE: employment, documents, communications and the
 * merge/duplicate machinery. Those hang off a person the way documents hang
 * off a case, and they belong to later stages.
 */

import type { Queryable } from "./db.js";
import type { Actor } from "./authorize.js";
import { recordCustomerEvent } from "./events.js";
import { ApiError, refusalMessage } from "./http.js";
import { can } from "./authorize.js";

const COLUMNS = `p.id, p.full_name, p.date_of_birth, p.address_line, p.locality, p.city,
                 p.district, p.state, p.pincode, p.is_active, p.created_at, p.updated_at`;

/**
 * Identifiers and aliases, as JSON aggregates on the person row.
 *
 * One query rather than three and a join in JavaScript: a list of 500 people
 * would otherwise be 1001 round trips. `filter (where ... is not null)` keeps
 * a person with no identifiers as `[]` rather than `[null]`.
 *
 * Expired identifiers are excluded. In India a disconnected mobile is
 * reissued, and migration 0002's comment is explicit that a number
 * identifying a customer in 2024 can belong to a stranger in 2027 — showing it
 * as their current number is how one person's history ends up attached to
 * another's.
 *
 * `valid_to` is read as the date the identifier STOPPED being valid, so the
 * comparison is `> current_date` and not `>=`. With `>=`, removing a number
 * today would leave it showing as current for the rest of the day: the
 * telecaller deletes it, the screen still shows it, and they delete it again.
 * The same boundary is used by `cases.ts` for the applicant's phone.
 */
const AGGREGATES = `
  coalesce((
    select json_agg(json_build_object(
             'id', i.id, 'type', i.identifier_type, 'value', i.value_raw,
             'isPrimary', i.is_primary, 'verificationSource', i.verification_source)
             order by i.is_primary desc, i.created_at)
      from person_identifier i
     where i.person_id = p.id
       and (i.valid_to is null or i.valid_to > current_date)
  ), '[]'::json) as identifiers,
  coalesce((
    select json_agg(a.alias order by a.created_at) from person_alias a where a.person_id = p.id
  ), '[]'::json) as aliases`;

export function customerFromRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    fullName: row.full_name,
    dateOfBirth: row.date_of_birth,
    addressLine: row.address_line,
    locality: row.locality,
    city: row.city,
    district: row.district,
    state: row.state,
    pincode: row.pincode,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    identifiers: row.identifiers ?? [],
    aliases: row.aliases ?? [],
  };
}

/** Field name in the API → column in `person`. A whitelist, not a loop over
 * the body: without it, `PATCH` would happily set `created_by` or clear
 * `merged_into_id`. */
const WRITABLE: Record<string, string> = {
  fullName: "full_name",
  dateOfBirth: "date_of_birth",
  addressLine: "address_line",
  locality: "locality",
  city: "city",
  district: "district",
  state: "state",
  pincode: "pincode",
};

const IDENTIFIER_TYPES = ["phone", "pan", "email", "bank_account"] as const;
type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

const VERIFICATION_SOURCES = [
  "self_declared",
  "seen_on_document",
  "verified_against_issuer",
] as const;

/**
 * What matching compares, per migration 0002: phone stripped to digits, PAN
 * upper-cased, email lower-cased. `value_raw` keeps what was typed, because
 * showing somebody a number they did not type back to them is its own small
 * betrayal of trust in the record.
 */
function normaliseIdentifier(type: IdentifierType, value: string): string {
  if (type === "phone") return value.replace(/\D/g, "");
  if (type === "pan") return value.trim().toUpperCase();
  if (type === "email") return value.trim().toLowerCase();
  return value.trim();
}

function requirePermission(actor: Actor, permission: string): void {
  if (!can(actor, permission, "all")) throw new ApiError(403, refusalMessage(permission));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listCustomers(client: Queryable, actor: Actor, query: string | null) {
  requirePermission(actor, "person.read");

  // A search term narrows in SQL rather than in the browser. The prototype
  // filtered an array it already held; a list capped at 500 rows cannot be
  // filtered client-side without silently searching only the first 500.
  const term = (query ?? "").trim();
  const digits = term.replace(/\D/g, "");

  const { rows } = await client.query(
    `select ${COLUMNS}, ${AGGREGATES}
       from person p
      where p.is_active and p.merged_into_id is null
        ${
          term.length === 0
            ? ""
            : `and (
                 p.full_name ilike '%' || $1 || '%'
                 or p.locality ilike '%' || $1 || '%'
                 or exists (select 1 from person_alias a
                             where a.person_id = p.id and a.alias ilike '%' || $1 || '%')
                 or ($2 <> '' and exists (
                       select 1 from person_identifier i
                        where i.person_id = p.id
                          and i.value_normalised like '%' || $2 || '%'))
               )`
        }
      order by p.full_name limit 500`,
    term.length === 0 ? [] : [term, digits],
  );
  return rows.map(customerFromRow);
}

export async function getCustomer(client: Queryable, actor: Actor, id: string) {
  requirePermission(actor, "person.read");
  const { rows } = await client.query(
    `select ${COLUMNS}, ${AGGREGATES} from person p where p.id = $1`,
    [id],
  );
  if (!rows[0]) throw new ApiError(404, "No such customer.");
  return customerFromRow(rows[0]);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Create a customer.
 *
 * Accepts an optional `phone`, which becomes their primary phone identifier in
 * the same transaction. The new-case form asks for a name and a number
 * together — that is one act to the telecaller taking the call, and splitting
 * it into two requests would leave a person with no number if the second one
 * failed.
 */
export async function createCustomer(
  client: Queryable,
  actor: Actor,
  body: Record<string, unknown>,
) {
  requirePermission(actor, "person.create");

  const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
  if (fullName.length === 0) throw new ApiError(400, "A customer needs a name.");

  const columns = ["full_name", "created_by"];
  const values: unknown[] = [fullName, actor.userId];
  for (const [field, column] of Object.entries(WRITABLE)) {
    if (field === "fullName") continue;
    if (body[field] !== undefined && body[field] !== null && body[field] !== "") {
      columns.push(column);
      values.push(body[field]);
    }
  }

  const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await client.query(
    `insert into person (${columns.join(", ")}) values (${placeholders}) returning id`,
    values,
  );
  const personId = rows[0]!.id;

  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  if (phone.length > 0) {
    await client.query(
      `insert into person_identifier
         (person_id, identifier_type, value_raw, value_normalised, is_primary, created_by)
       values ($1, 'phone', $2, $3, true, $4)`,
      [personId, phone, normaliseIdentifier("phone", phone), actor.userId],
    );
  }

  // Field NAMES, not values — every column on `person` is personal data. See
  // the payload rules in events.ts. No duplicate-event guard is needed on a
  // create: a retried request creates a second person and correctly gets a
  // second event, because there genuinely are two records.
  await recordCustomerEvent(client, {
    actorUserId: actor.userId,
    personId,
    eventType: "person.created",
    payloadAfter: {
      fields: columns.filter((column) => column !== "created_by"),
      identifierTypes: phone.length > 0 ? ["phone"] : [],
    },
  });

  return await getCustomer(client, actor, personId);
}

/**
 * Edit a customer's own fields.
 *
 * ONLY GENUINELY CHANGED FIELDS ARE WRITTEN, and an edit that changes nothing
 * writes no event. This is not a micro-optimisation: the screen submits the
 * whole form, so "Save" pressed twice, or a request the browser retried after
 * a dropped connection, would otherwise append a second `person.updated`
 * saying somebody edited a record they did not edit. An audit log that records
 * non-events is one people stop believing.
 */
export async function updateCustomer(
  client: Queryable,
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  requirePermission(actor, "person.update");

  const submitted = Object.entries(WRITABLE).filter(([field]) => body[field] !== undefined);
  if (submitted.length === 0) throw new ApiError(400, "Nothing to update.");

  const { rows: existing } = await client.query(
    `select ${Object.values(WRITABLE).join(", ")} from person where id = $1`,
    [id],
  );
  if (!existing[0]) throw new ApiError(404, "No such customer.");

  const sets: string[] = [];
  const values: unknown[] = [];
  const changedFields: string[] = [];
  for (const [field, column] of submitted) {
    const wanted = body[field] === "" ? null : body[field];
    if (sameValue(existing[0][column], wanted)) continue;
    values.push(wanted);
    sets.push(`${column} = $${values.length}`);
    changedFields.push(field);
  }

  if (sets.length === 0) return await getCustomer(client, actor, id);

  values.push(id);
  await client.query(
    `update person set ${sets.join(", ")} where id = $${values.length}`,
    values,
  );

  await recordCustomerEvent(client, {
    actorUserId: actor.userId,
    personId: id,
    eventType: "person.updated",
    payloadAfter: { changedFields },
  });

  return await getCustomer(client, actor, id);
}

/**
 * Whether a stored column and a submitted value are the same fact.
 *
 * Compared as text because the driver hands back a `Date` for `date_of_birth`
 * while the form submits `"1985-03-14"`, and `===` on those is false forever —
 * which would make every save look like a change and every re-save append an
 * event. `null` and `undefined` are one case: both mean "not set".
 */
function sameValue(stored: unknown, submitted: unknown): boolean {
  if (stored == null && submitted == null) return true;
  if (stored == null || submitted == null) return false;
  const asText = (value: unknown): string =>
    value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  return asText(stored) === asText(submitted);
}

/**
 * Replace a customer's identifiers outright.
 *
 * EXPIRED, NOT DELETED. A number that is removed gets `valid_to = today`
 * rather than vanishing: migration 0002 exists to be able to say a 2024 call
 * was to whoever held that number in 2024, and a delete would make every past
 * communication look like it was with the current holder. This is the same
 * shape as revoking a role rather than deleting the row.
 *
 * Identifiers that are unchanged are left alone entirely, so re-saving the
 * form does not expire and re-create a number that never moved.
 */
export async function setCustomerIdentifiers(
  client: Queryable,
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  requirePermission(actor, "person.update");

  const { rows: exists } = await client.query(`select id from person where id = $1`, [id]);
  if (!exists[0]) throw new ApiError(404, "No such customer.");

  if (!Array.isArray(body.identifiers)) {
    throw new ApiError(400, "Identifiers must be a list.");
  }

  const wanted = body.identifiers.map((raw) => {
    const entry = raw as Record<string, unknown>;
    const type = String(entry.type ?? "");
    const value = typeof entry.value === "string" ? entry.value.trim() : "";
    const verificationSource = String(entry.verificationSource ?? "self_declared");

    if (!(IDENTIFIER_TYPES as readonly string[]).includes(type)) {
      throw new ApiError(400, `Unknown identifier type: ${type}.`);
    }
    if (value.length === 0) {
      throw new ApiError(400, "An identifier needs a value.");
    }
    if (!(VERIFICATION_SOURCES as readonly string[]).includes(verificationSource)) {
      throw new ApiError(400, `Unknown verification source: ${verificationSource}.`);
    }
    return {
      type: type as IdentifierType,
      value,
      normalised: normaliseIdentifier(type as IdentifierType, value),
      isPrimary: entry.isPrimary === true,
      verificationSource,
    };
  });

  // At most one primary per type — the UI offers a single "primary" toggle per
  // kind and `primaryPhone()` reads exactly one. Two would make which one
  // shows a matter of row order.
  for (const type of IDENTIFIER_TYPES) {
    if (wanted.filter((entry) => entry.type === type && entry.isPrimary).length > 1) {
      throw new ApiError(400, `Only one ${type} can be the primary one.`);
    }
  }

  const { rows: current } = await client.query(
    `select id, identifier_type, value_normalised, is_primary, verification_source
       from person_identifier
      where person_id = $1 and (valid_to is null or valid_to > current_date)`,
    [id],
  );

  const keyOf = (type: string, normalised: string): string => `${type} ${normalised}`;
  const wantedKeys = new Set(wanted.map((entry) => keyOf(entry.type, entry.normalised)));

  // IDs and types, never values — a phone number copied into the log is
  // unerasable personal data (ADR-018), and the id is enough to find the row
  // it describes.
  const expired: { id: string; type: string }[] = [];
  const added: { type: string }[] = [];
  const amended: { id: string; type: string }[] = [];

  for (const row of current) {
    if (!wantedKeys.has(keyOf(row.identifier_type, row.value_normalised))) {
      await client.query(
        `update person_identifier set valid_to = current_date where id = $1`,
        [row.id],
      );
      expired.push({ id: row.id, type: row.identifier_type });
    }
  }

  for (const entry of wanted) {
    const existing = current.find(
      (row: Record<string, unknown>) =>
        keyOf(row.identifier_type as string, row.value_normalised as string) ===
        keyOf(entry.type, entry.normalised),
    );
    if (existing) {
      if (
        existing.is_primary !== entry.isPrimary ||
        existing.verification_source !== entry.verificationSource
      ) {
        await client.query(
          `update person_identifier set is_primary = $1, verification_source = $2 where id = $3`,
          [entry.isPrimary, entry.verificationSource, existing.id],
        );
        amended.push({ id: existing.id, type: entry.type });
      }
      continue;
    }
    await client.query(
      `insert into person_identifier
         (person_id, identifier_type, value_raw, value_normalised, is_primary,
          verification_source, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        entry.type,
        entry.value,
        entry.normalised,
        entry.isPrimary,
        entry.verificationSource,
        actor.userId,
      ],
    );
    added.push({ type: entry.type });
  }

  // Re-submitting the same contacts unchanged is a no-op, so it appends
  // nothing. The screen sends the whole list every time and the browser may
  // retry it; an event per submission would turn "who changed this number"
  // into a list of people who opened the dialog.
  if (expired.length > 0 || added.length > 0 || amended.length > 0) {
    await recordCustomerEvent(client, {
      actorUserId: actor.userId,
      personId: id,
      eventType: "person.identifier_updated",
      payloadAfter: { added, expired, amended },
    });
  }

  return await getCustomer(client, actor, id);
}
