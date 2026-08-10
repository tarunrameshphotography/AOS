/**
 * The lender catalogue, read-only — institutions, their branches and active
 * contacts, for the "which bank does this go to" picker on the Banks tab.
 *
 * Stage 3D. Maintaining the catalogue (adding a bank, editing a branch) stays
 * out of scope here, exactly as Milestone 8 (Database/migrations/0019) drew
 * the line: this reads what is already seeded (0020, 0025), it does not
 * write it.
 */

import type { Queryable } from "./db.js";
import { can, type Actor } from "./authorize.js";
import { ApiError, refusalMessage } from "./http.js";

export interface LenderContact {
  readonly id: string;
  readonly name: string | null;
  readonly designation: string | null;
  readonly workEmail: string | null;
  readonly workMobile: string | null;
  readonly isPrimary: boolean;
}

export interface LenderBranch {
  readonly id: string;
  readonly name: string;
  readonly city: string | null;
  readonly addressLine: string | null;
  readonly operationalStatus: string;
  readonly contacts: readonly LenderContact[];
}

export interface Lender {
  readonly id: string;
  readonly name: string;
  readonly lenderType: string | null;
  readonly branches: readonly LenderBranch[];
}

/**
 * Institutions with their branches and active contacts, nested for a
 * cascading picker. Not case-scoped — no role holds `organisation.read` at
 * `own` (src/domain/permissions/roles.ts), because a lender is master data,
 * not a fact owned by whoever is looking at one case.
 */
export async function listLenders(client: Queryable, actor: Actor): Promise<Lender[]> {
  if (!can(actor, "organisation.read", "all")) {
    throw new ApiError(403, refusalMessage("organisation.read"));
  }

  const institutions = await client.query<{
    id: string;
    canonical_name: string;
    lender_type: string | null;
  }>(
    `select o.id, o.canonical_name, lp.lender_type::text as lender_type
       from organisation o
       left join lender_profile lp on lp.organisation_id = o.id
      where 'lender' = any(o.roles) and o.is_active and o.merged_into_id is null
      order by o.canonical_name`,
  );

  const branches = await client.query<{
    id: string;
    canonical_name: string;
    parent_organisation_id: string | null;
    city_name: string | null;
    org_city: string | null;
    address_line: string | null;
    operational_status: string | null;
  }>(
    `select b.id, b.canonical_name, b.parent_organisation_id, b.city as org_city,
            c.name as city_name, bb.address_line, bb.operational_status
       from organisation b
       left join bank_branch bb on bb.organisation_id = b.id
       left join city c on c.id = bb.city_id
      where 'branch' = any(b.roles) and b.is_active and b.merged_into_id is null
      order by b.canonical_name`,
  );

  const contacts = await client.query<{
    id: string;
    branch_organisation_id: string | null;
    contact_name: string | null;
    person_full_name: string | null;
    designation: string | null;
    work_email: string | null;
    work_mobile: string | null;
    is_primary_contact: boolean;
  }>(
    `select bc.id, bc.branch_organisation_id, bc.contact_name, p.full_name as person_full_name,
            bc.designation, bc.work_email, bc.work_mobile, bc.is_primary_contact
       from bank_contact bc
       left join person p on p.id = bc.person_id
      where bc.is_active and bc.branch_organisation_id is not null
      order by bc.is_primary_contact desc, coalesce(bc.contact_name, p.full_name)`,
  );

  const contactsByBranch = new Map<string, LenderContact[]>();
  for (const row of contacts.rows) {
    const branchId = row.branch_organisation_id;
    if (!branchId) continue;
    const list = contactsByBranch.get(branchId) ?? [];
    list.push({
      id: row.id,
      name: row.contact_name ?? row.person_full_name,
      designation: row.designation,
      workEmail: row.work_email,
      workMobile: row.work_mobile,
      isPrimary: row.is_primary_contact,
    });
    contactsByBranch.set(branchId, list);
  }

  const branchesByInstitution = new Map<string, LenderBranch[]>();
  for (const row of branches.rows) {
    const institutionId = row.parent_organisation_id;
    if (!institutionId) continue;
    const list = branchesByInstitution.get(institutionId) ?? [];
    list.push({
      id: row.id,
      name: row.canonical_name,
      city: row.city_name ?? row.org_city,
      addressLine: row.address_line,
      operationalStatus: row.operational_status ?? "operational",
      contacts: contactsByBranch.get(row.id) ?? [],
    });
    branchesByInstitution.set(institutionId, list);
  }

  return institutions.rows.map((row) => ({
    id: row.id,
    name: row.canonical_name,
    lenderType: row.lender_type,
    branches: branchesByInstitution.get(row.id) ?? [],
  }));
}
