/**
 * Reference data and search, read-only.
 *
 * WHY THIS IS PART OF THE CUSTOMER/CASE SLICE and not a later stage: a case
 * carries a `loan_product_id` and a `referral_source_id`, and neither means
 * anything to a person without the catalogue that names them. Once cases come
 * from PostgreSQL, their product ids are PostgreSQL ids — the prototype
 * store's own `loanProducts` array has different ids for the same products and
 * cannot label them. Migrating the case without its labels would render "New
 * case · —" on every row.
 *
 * So this is deliberately the READ half only. Maintaining master data — adding
 * a product, deactivating a referral source — stays on the prototype store
 * with the rest of the administration screens, and moves in a later stage.
 * `master_data.read` is held by every role; `master_data.manage` is not, and
 * nothing here honours it.
 *
 * SEARCH IS HERE for the same reason. The global search box matches people by
 * name, alias, locality and identifier, and cases by number, applicant and
 * product — all of which now live in the database. A search that ran over a
 * 500-row page the browser happened to be holding would quietly stop finding
 * the 501st customer.
 */

import type { Queryable } from "./db.js";
import { can, widestScopeFor, type Actor } from "./authorize.js";
import { ApiError, refusalMessage } from "./http.js";

/**
 * The catalogues the case screens need to render and to offer choices.
 *
 * One endpoint rather than three: every screen that needs one needs the
 * others, it is small, it changes about twice a year, and three requests on
 * every page load to build one dropdown is how a local network starts feeling
 * slow.
 */
export async function readReference(client: Queryable, actor: Actor) {
  if (!can(actor, "master_data.read", "all")) {
    throw new ApiError(403, refusalMessage("master_data.read"));
  }

  const products = await client.query(
    // The customer product's name is what office staff actually say ("Home
    // Loan"), with the product's own name beneath it. `category`/`variant` are
    // the pre-catalogue text pair, kept populated by migration 0016 and used
    // only as a fallback for rows written before the catalogue existed.
    //
    // `customer_product_code`, `property_requirement` and `gst_requirement`
    // ride along for the New Case screen's progressive disclosure: which
    // questions a loan type reveals is decided by what the product declares
    // (ADR-032), never by a hard-coded list of product codes in the browser.
    `select p.id, p.name, p.category, p.variant, p.code, p.is_active, p.display_order,
            cp.name as customer_product_name, cp.code as customer_product_code,
            pr.code as property_requirement, gr.code as gst_requirement
       from loan_product p
       left join customer_product cp on cp.id = p.customer_product_id
       left join requirement_applicability pr on pr.id = p.property_requirement_id
       left join requirement_applicability gr on gr.id = p.gst_requirement_id
      order by p.display_order, p.category, p.variant`,
  );

  // Which employment types, borrower types and constitutions each product is
  // actually offered to (0015/0016). This is what makes the intake form ask
  // only the questions the chosen loan type can answer: a Professional Loan
  // offers "self-employed professional", a Two-Wheeler Loan offers everything,
  // and neither list is written down twice.
  const productEmployment = await client.query(
    `select loan_product_id, employment_type_id from loan_product_employment_type`,
  );
  const productBorrower = await client.query(
    `select loan_product_id, borrower_type_id from loan_product_borrower_type`,
  );
  const productConstitution = await client.query(
    `select loan_product_id, business_constitution_id from loan_product_business_constitution`,
  );

  const applicable = (
    rows: readonly Record<string, unknown>[],
    key: string,
  ): Map<string, string[]> => {
    const byProduct = new Map<string, string[]>();
    for (const row of rows) {
      const productId = row.loan_product_id as string;
      const list = byProduct.get(productId) ?? [];
      list.push(row[key] as string);
      byProduct.set(productId, list);
    }
    return byProduct;
  };

  const employmentByProduct = applicable(productEmployment.rows, "employment_type_id");
  const borrowerByProduct = applicable(productBorrower.rows, "borrower_type_id");
  const constitutionByProduct = applicable(productConstitution.rows, "business_constitution_id");

  // The master-data lists the intake form turns into dropdowns. Small, closed,
  // and changed about twice a year — the same reasoning that put products and
  // referral sources on this one endpoint rather than on four.
  const employmentTypes = await client.query(
    `select id, code, name, is_active, display_order from employment_type order by display_order, name`,
  );
  const borrowerTypes = await client.query(
    `select id, code, name, is_active, display_order from borrower_type order by display_order, name`,
  );
  const businessConstitutions = await client.query(
    `select id, code, name, is_active, display_order from business_constitution order by display_order, name`,
  );
  const propertyTypes = await client.query(
    `select id, code, name, is_active, display_order from property_type order by display_order, name`,
  );

  const referralSources = await client.query(
    `select id, code, name, is_active, display_order
       from referral_source order by display_order, name`,
  );

  const simpleList = (rows: readonly Record<string, unknown>[]) =>
    rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      isActive: row.is_active,
      displayOrder: row.display_order,
    }));

  return {
    employmentTypes: simpleList(employmentTypes.rows),
    borrowerTypes: simpleList(borrowerTypes.rows),
    businessConstitutions: simpleList(businessConstitutions.rows),
    propertyTypes: simpleList(propertyTypes.rows),
    loanProducts: products.rows.map((row: Record<string, unknown>) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      variant: row.variant,
      code: row.code,
      isActive: row.is_active,
      displayOrder: row.display_order,
      customerProductName: row.customer_product_name,
      customerProductCode: row.customer_product_code,
      propertyRequirement: row.property_requirement,
      gstRequirement: row.gst_requirement,
      employmentTypeIds: employmentByProduct.get(row.id as string) ?? [],
      borrowerTypeIds: borrowerByProduct.get(row.id as string) ?? [],
      businessConstitutionIds: constitutionByProduct.get(row.id as string) ?? [],
      /** "Home Loan · Home Loan — Purchase". Built here so every screen shows
       * the same label and none of them has to know the fallback rule. */
      label: `${row.customer_product_name ?? row.category} · ${row.name ?? row.variant}`,
    })),
    referralSources: referralSources.rows.map((row: Record<string, unknown>) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      isActive: row.is_active,
      displayOrder: row.display_order,
    })),
  };
}

export interface SearchHit {
  readonly kind: "person" | "case";
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly matchedOn: string;
}

/**
 * One box, mixed results.
 *
 * Deliberately forgiving: people search with a fragment, a misspelling, a
 * locality, or four digits of a phone number, and every one of those must work
 * — it is the product's central promise, not a nice-to-have
 * (PRD/Identity Resolution.md Part 7).
 *
 * CASES ARE SCOPE-FILTERED AND PEOPLE ARE NOT, which looks inconsistent and is
 * not. `person.read` is held at `all` by every role — a telecaller must be
 * able to discover that the caller is an existing customer, and that
 * recognition is the core promise of the product. `case.read` is `own` for a
 * telecaller, so search must not become the hole through which a colleague's
 * caseload is visible: the same filter the list uses is applied here.
 */
export async function search(
  client: Queryable,
  actor: Actor,
  rawQuery: string,
): Promise<SearchHit[]> {
  const term = rawQuery.trim();
  if (term.length < 2) return [];

  const digits = term.replace(/\D/g, "");
  const hits: SearchHit[] = [];

  if (can(actor, "person.read", "all")) {
    const { rows } = await client.query(
      `select p.id, p.full_name, p.locality, p.city,
              (select a.alias from person_alias a
                where a.person_id = p.id and a.alias ilike '%' || $1 || '%' limit 1) as alias_hit,
              (select i.identifier_type from person_identifier i
                where i.person_id = p.id and $2 <> ''
                  and i.value_normalised like '%' || $2 || '%' limit 1) as identifier_hit,
              (select count(*)::int from case_party cp
                where cp.person_id = p.id and cp.removed_at is null) as case_count
         from person p
        where p.is_active and p.merged_into_id is null
          and (
            p.full_name ilike '%' || $1 || '%'
            or p.locality ilike '%' || $1 || '%'
            or exists (select 1 from person_alias a
                        where a.person_id = p.id and a.alias ilike '%' || $1 || '%')
            or ($2 <> '' and exists (select 1 from person_identifier i
                                      where i.person_id = p.id
                                        and i.value_normalised like '%' || $2 || '%'))
          )
        order by p.full_name limit 8`,
      [term, digits],
    );

    for (const row of rows) {
      // Why it matched, in the order a person would expect to be told.
      const matchedOn =
        row.full_name.toLowerCase().includes(term.toLowerCase())
          ? "Name"
          : row.alias_hit
            ? `Also known as "${row.alias_hit}"`
            : row.identifier_hit
              ? String(row.identifier_hit).replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())
              : `Locality — ${row.locality}`;

      hits.push({
        kind: "person",
        id: row.id,
        title: row.full_name,
        subtitle:
          row.case_count > 0
            ? `${row.case_count} case${row.case_count === 1 ? "" : "s"} · ${row.locality ?? "—"}`
            : (row.locality ?? "No cases yet"),
        matchedOn,
      });
    }
  }

  const caseScope = widestScopeFor(actor, "case.read");
  if (caseScope !== null) {
    const ownOnly = caseScope === "own";
    const { rows } = await client.query(
      `select c.id, c.case_number, c.stage,
              ap.full_name as applicant_name,
              coalesce(cp.name, lp.category) || ' · ' || coalesce(lp.name, lp.variant) as product_label
         from loan_case c
         left join case_party pa
                on pa.case_id = c.id and pa.is_primary and pa.removed_at is null
         left join person ap on ap.id = pa.person_id
         left join loan_product lp on lp.id = c.loan_product_id
         left join customer_product cp on cp.id = lp.customer_product_id
        where (
                c.case_number ilike '%' || $1 || '%'
                or ap.full_name ilike '%' || $1 || '%'
                or coalesce(lp.name, lp.variant) ilike '%' || $1 || '%'
              )
          ${ownOnly ? "and c.owner_user_id = $2" : ""}
        order by c.created_at desc limit 8`,
      ownOnly ? [term, actor.userId] : [term],
    );

    for (const row of rows) {
      const matchedOn = row.case_number.toLowerCase().includes(term.toLowerCase())
        ? "Case number"
        : row.applicant_name?.toLowerCase().includes(term.toLowerCase())
          ? `Applicant — ${row.applicant_name}`
          : "Loan type";

      hits.push({
        kind: "case",
        id: row.id,
        title: `${row.case_number} · ${row.applicant_name ?? "No applicant"}`,
        subtitle: `${row.product_label ?? "—"} · ${String(row.stage).replace(/_/g, " ")}`,
        matchedOn,
      });
    }
  }

  return hits;
}
