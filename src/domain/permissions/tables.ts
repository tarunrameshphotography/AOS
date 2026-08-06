/**
 * Table bindings — which permission governs which operation, on every table.
 *
 * Source of truth: ADR-026, ADR-027
 *
 * ADR-027 requires that every table names the permission governing each
 * operation. A table with no binding is a test failure, not an unprotected
 * table that ships. Tables with no permission of their own bind to their
 * parent's — `case_party` is governed by `case.read` / `case.update` — which is
 * a permission model, not an absence of one.
 *
 * This file is also the schema's table list. The migration that creates a table
 * and the binding that protects it are written together, so a table cannot exist
 * without a security model.
 */

import type { Scope, ScopeFamily } from "./scopes.js";
import type { Role } from "./roles.js";

/**
 * How an operation is authorised.
 *
 * `permission` — a client holding any one of these may perform it, at the scope
 * their grant carries. "Any of" rather than "all of" because some operations are
 * reachable two ways: a requirement row is updated both by the ordinary document
 * flow and by an explicit waiver.
 *
 * `internal` — no client role may do it. The base table is written only by a
 * SECURITY DEFINER function or a migration. Case-number allocation and the event
 * log are the cases: allowing a client to write an event directly would let
 * someone forge history, and BR-050 makes the paired write the domain layer's
 * job anyway.
 *
 * `forbidden` — nobody, ever, including internally. Deletes on append-only
 * tables. Distinguished from `internal` so that "no policy exists" and "a policy
 * exists that refuses everyone" are different, visible states.
 */
export type OperationBinding =
  | { readonly kind: "permission"; readonly anyOf: readonly string[] }
  | { readonly kind: "internal"; readonly reason: string }
  | { readonly kind: "forbidden"; readonly reason: string };

function permits(...anyOf: readonly string[]): OperationBinding {
  return { kind: "permission", anyOf };
}

function internal(reason: string): OperationBinding {
  return { kind: "internal", reason };
}

function forbidden(reason: string): OperationBinding {
  return { kind: "forbidden", reason };
}

/** A column hidden by a masking expression in the client-facing view (ADR-026). */
export interface MaskedColumn {
  readonly column: string;
  /** The column-level permission that reveals it. */
  readonly revealedBy: string;
  /** What an unentitled reader sees instead. Never null — null is indistinguishable from absent. */
  readonly maskedAs: string;
}

export interface TableBinding {
  readonly table: string;
  readonly family: ScopeFamily;
  readonly select: OperationBinding;
  readonly insert: OperationBinding;
  readonly update: OperationBinding;
  readonly delete: OperationBinding;
  readonly maskedColumns?: readonly MaskedColumn[];
  /** Why this table exists, in one line. Every table must answer it. */
  readonly purpose: string;
  /** Anything a policy author needs that the bindings alone do not say. */
  readonly notes?: string;
}

const NEVER_DELETED = forbidden(
  "Nothing is hard-deleted (BR-003, BR-013, BR-041). Rows are deactivated, " +
    "tombstoned or marked terminal.",
);

export const TABLE_BINDINGS: readonly TableBinding[] = [
  // ── Identity ─────────────────────────────────────────────────────────────
  {
    table: "person",
    family: "reference",
    purpose: "Every human AOS knows, exactly once. Identity is the surrogate ID (ADR-013).",
    select: permits("person.read"),
    insert: permits("person.create"),
    update: permits("person.update", "person.merge"),
    delete: NEVER_DELETED,
    notes:
      "Redaction under ADR-018 nulls personal columns in place and is performed by " +
      "an internal function, not by `person.update` — erasure is not an edit.",
  },
  {
    table: "person_identifier",
    family: "reference",
    purpose:
      "The evidence by which a person is recognised — phone, PAN, email, bank account " +
      "— each with a validity period so recycled numbers stay safe (ADR-013).",
    select: permits("person.read"),
    insert: permits("person.update"),
    update: permits("person.update"),
    delete: NEVER_DELETED,
    maskedColumns: [
      {
        column: "value_raw",
        revealedBy: "identifier.view_full",
        maskedAs: "value_masked — last four characters, the rest as x",
      },
    ],
    notes:
      "`value_normalised` is masked identically: it is the search key, and leaving " +
      "it exposed would let anyone reconstruct the raw value by probing. The full " +
      "value is otherwise reachable only through `app.reveal_identifier()`, which " +
      "always writes an event, granted or denied (ADR-026).",
  },
  {
    table: "person_alias",
    family: "reference",
    purpose:
      "Every wrong-but-used spelling of a name, kept because that spelling is what " +
      "somebody will search next time.",
    select: permits("person.read"),
    insert: permits("person.update", "person.create", "person.merge"),
    update: permits("person.update"),
    delete: NEVER_DELETED,
  },
  {
    table: "app_user",
    family: "self",
    purpose: "A person who can log into AOS. One-to-one with person, optional.",
    select: permits("user.read"),
    insert: permits("user.manage"),
    update: permits("user.manage"),
    delete: NEVER_DELETED,
    notes:
      "Named `app_user` rather than `user`, which is reserved in Postgres. Carries " +
      "the link to the auth session identity — every RLS policy depends on it.",
  },
  {
    table: "user_role",
    family: "self",
    purpose:
      "Role assignments. Runtime data, never a migration — a user holds many roles " +
      "and receives the union of their permissions (BR-061, ADR-022).",
    select: permits("user.read"),
    insert: permits("role.assign"),
    update: permits("role.assign"),
    delete: NEVER_DELETED,
    notes: "Revocation sets `revoked_at`. A revoked role must remain visible in history.",
  },
  {
    table: "permission",
    family: "reference",
    purpose:
      "The catalog itself, as rows. Exists so `role_permission` can carry a foreign " +
      "key: without it, a typo in a grant is a silently dead permission rather than " +
      "a failed migration (ADR-027).",
    select: permits("master_data.read"),
    insert: internal(
      "Seeded by migration from `actions.ts`. A permission that exists in the " +
        "database and not in the catalog would be unreachable by any check.",
    ),
    update: internal("As for insert — the catalog is code, and the table is its projection."),
    delete: internal(
      "Withdrawing a permission is a code change followed by a re-seed, so that the " +
        "grants referencing it fail loudly rather than dangle.",
    ),
  },
  {
    table: "role_permission",
    family: "reference",
    purpose:
      "Which permissions a role carries. Read by `app.has_permission()`; seeded from " +
      "`src/domain/permissions/` by migration (ADR-022).",
    select: permits("master_data.read"),
    insert: internal(
      "Seeded by migration from the domain catalog. Hand-editing it would create a " +
        "second definition of the permission model, which is the failure ADR-022 exists " +
        "to prevent.",
    ),
    update: internal(
      "Changing a grant at runtime would silently diverge from the catalog that " +
        "produced it. A grant changes by editing `roles.ts` and re-seeding.",
    ),
    delete: internal(
      "A withdrawn grant is removed by the seeding migration, never at runtime, for " +
        "the same reason.",
    ),
  },
  {
    table: "referrer_profile",
    family: "reference",
    purpose: "A person who sends business, and the terms they send it on.",
    select: permits("person.read"),
    insert: permits("person.update"),
    update: permits("person.update"),
    delete: NEVER_DELETED,
    maskedColumns: [
      {
        column: "commission_terms",
        revealedBy: "commercial.view",
        maskedAs: "null-shaped placeholder — the presence of terms is visible, the terms are not",
      },
    ],
    notes:
      "Writing commission terms is governed by `person.update` while reading them " +
      "is governed by `commercial.view`, and no role currently holds both. Surfaced " +
      "by the ADR-027 derivation; it sharpens the standing open question of whether " +
      "Manager should hold `commercial.view`.",
  },
  {
    table: "bank_contact",
    family: "reference",
    purpose:
      "A person's working relationship with a bank branch, modelled as a relationship " +
      "so a manager changing branches is one new row rather than a lost contact.",
    select: permits("organisation.read"),
    insert: permits("organisation.update"),
    update: permits("organisation.update"),
    delete: NEVER_DELETED,
  },

  // ── The case and everything on it ────────────────────────────────────────
  {
    table: "loan_case",
    family: "case-derived",
    purpose:
      "One loan application journey, from first call to invoice. The centre of the " +
      "system. Named `loan_case` because `case` is reserved in SQL, and quoting it " +
      "in every policy is a typo waiting to happen — the same reason as `app_user`.",
    select: permits("case.read"),
    insert: permits("case.create"),
    update: permits(
      "case.update",
      "case.assign",
      "case.hold",
      "case.mark_lost",
      "case.reopen",
      "case.close",
    ),
    delete: NEVER_DELETED,
    notes:
      "The five stage-and-ownership permissions each govern a distinct column set. " +
      "They are separated in policy, not merged into `case.update`, because a " +
      "telecaller may correct a requested amount on their own case but only Finance " +
      "may close one.",
  },
  {
    table: "case_party",
    family: "case-derived",
    purpose:
      "The people, and the borrowing firm, attached to a case. The only mandatory " +
      "party is the primary applicant (BR-010).",
    select: permits("case.read"),
    insert: permits("case.update"),
    update: permits("case.update"),
    delete: NEVER_DELETED,
    notes:
      "Removing a party sets `removed_at` and turns that party's requirements " +
      "`not_applicable` (Workflow.md). A hard delete would erase the fact that the " +
      "case once had a co-applicant, which is exactly what the timeline is for.",
  },
  {
    table: "case_property",
    family: "case-derived",
    purpose: "Which properties a case involves, and in what role.",
    select: permits("case.read"),
    insert: permits("case.update"),
    update: permits("case.update"),
    delete: NEVER_DELETED,
    notes:
      "A property changed mid-case stays linked to the case's history rather than " +
      "being unlinked (Workflow.md — edge cases).",
  },
  {
    table: "case_number_sequence",
    family: "reference",
    purpose:
      "One row per year holding the last allocated case number. A counter rather " +
      "than a Postgres sequence, because sequences gap on rollback and a customer " +
      "quoting AL-2026-00087 when 71 cases exist invites a question with no good " +
      "answer (ADR-024).",
    select: internal("The counter is not information any user needs. Exposing it would invite reports that treat case numbers as a count of business done, which they are not."),
    insert: internal(
      "A year's row is created by `app.allocate_case_number()` on the first case of " +
        "that year. Rollover is a new row, not a migration.",
    ),
    update: internal(
      "Allocation is `app.allocate_case_number()`, which locks the row and increments " +
        "it. A client that could increment the counter could skip numbers.",
    ),
    delete: forbidden("A year's counter is never removed; rollover creates a new row."),
  },
  {
    table: "document_requirement",
    family: "case-derived",
    purpose:
      "What a given case still needs, generated from its actual composition rather " +
      "than a universal checklist (BR-033). Answers the login desk's one question.",
    select: permits("case.read"),
    insert: permits("case.update"),
    update: permits("case.update", "document.verify", "requirement.waive"),
    delete: NEVER_DELETED,
    notes:
      "Requirements are regenerated, never deleted: a no-longer-relevant row becomes " +
      "`not_applicable` (BR-034). Generation runs in the same transaction as the " +
      "change that triggered it.",
  },
  {
    table: "document",
    family: "case-derived",
    purpose:
      "One uploaded file, owned by the person, property, organisation or case it " +
      "describes — never by two (BR-030, ADR-007).",
    select: permits("document.read"),
    insert: permits("document.upload"),
    update: permits("document.upload", "document.verify"),
    delete: forbidden(
      "Documents are versioned and never overwritten (BR-031). `document.delete_version` " +
        "exists in the catalog and is granted to nobody.",
    ),
    notes:
      "`own` reaches a document through the cases that reference it, not through its " +
      "owner: an Aadhaar belongs to a person whose KYC is referenced by cases owned " +
      "by three different people (ADR-027).",
  },
  {
    table: "task",
    family: "case-derived",
    purpose: "Something a human must do, in the future. Tasks are intent; events are fact.",
    select: permits("task.read"),
    insert: permits("task.create", "task.assign"),
    update: permits("task.update", "task.assign"),
    delete: NEVER_DELETED,
  },
  {
    table: "communication",
    family: "case-derived",
    purpose:
      "A real exchange with a person — call, WhatsApp, email, SMS, meeting — logged " +
      "against both the person and the case.",
    select: permits("communication.read"),
    insert: permits("communication.log"),
    update: forbidden("A record of what was said is not editable after the fact."),
    delete: NEVER_DELETED,
  },
  {
    table: "note",
    family: "case-derived",
    purpose:
      "Internal commentary on a case — the judgement and context that has nowhere " +
      "structured to live.",
    select: permits("note.read"),
    insert: permits("note.create"),
    update: permits("note.create"),
    delete: NEVER_DELETED,
    notes:
      "Editable only by its author within a short window, enforced in the policy. " +
      "Notes remain the known redaction leak under ADR-018 — users will type names " +
      "into them — and that is a policy question, not a schema one.",
  },
  {
    table: "event",
    family: "case-derived",
    purpose:
      "The append-only spine. Every timeline, audit trail, MIS report and AI summary " +
      "reads from here (ADR-005).",
    select: permits("event.view"),
    insert: internal(
      "Written by the domain layer in the same transaction as the state change " +
        "(BR-050). A client that could insert directly could forge history.",
    ),
    update: forbidden("Append-only. No updates (BR-051)."),
    delete: forbidden("Append-only. No deletes (BR-051). The event skeleton survives redaction (ADR-018)."),
  },

  // ── Organisations, banks and products ────────────────────────────────────
  {
    table: "organisation",
    family: "reference",
    purpose:
      "Every non-human party: employers, borrowing firms, builders, developers, " +
      "vendors, banks and branches (ADR-014, ADR-015).",
    select: permits("organisation.read"),
    insert: permits("organisation.create", "master_data.manage"),
    update: permits("organisation.update", "master_data.manage", "organisation.merge"),
    delete: NEVER_DELETED,
    notes:
      "One table, two governance regimes. Rows carrying the `lender` or `branch` role " +
      "are master data and require `master_data.manage` to write; every other row is " +
      "resolved into existence by a telecaller typing an employer name and requires " +
      "only `organisation.create` / `organisation.update`. The policy tests the role " +
      "flags. Without this split, adding a bank would need no more privilege than " +
      "typing an employer.",
  },
  {
    table: "organisation_alias",
    family: "reference",
    purpose:
      "Alternative names, so that IIFL / IIFL Home Finance Ltd / India Infoline resolve " +
      "to one lender.",
    select: permits("organisation.read"),
    insert: permits("organisation.create", "organisation.update", "organisation.merge"),
    update: permits("organisation.update"),
    delete: NEVER_DELETED,
  },
  {
    table: "lender_profile",
    family: "reference",
    purpose: "Bank-specific operational facts: lender type, panel status, standard turnaround.",
    select: permits("organisation.read"),
    insert: permits("master_data.manage"),
    update: permits("master_data.manage"),
    delete: NEVER_DELETED,
  },
  {
    table: "loan_product",
    family: "reference",
    purpose:
      "Amaze's own bank-independent lending product catalogue — the middle layer " +
      "between customer_product and bank_product. Known at case creation, which is " +
      "what makes the requirement engine possible (ADR-016, ADR-032, ADR-033).",
    select: permits("master_data.read"),
    insert: permits("master_data.manage"),
    update: permits("master_data.manage"),
    delete: NEVER_DELETED,
    notes:
      "Retirement is is_active = false plus effective_to; revision is a new row " +
      "pointing at the old one through supersedes_loan_product_id (Database/" +
      "migrations/0015). Neither flow is built yet; the columns exist so the " +
      "first one is data entry rather than a migration.",
  },
  {
    table: "bank_product",
    family: "reference",
    purpose: "A specific lender's offering, mapped to a loan_product. Drives submission rules.",
    select: permits("master_data.read"),
    insert: permits("master_data.manage"),
    update: permits("master_data.manage"),
    delete: NEVER_DELETED,
  },
  {
    table: "borrower_type",
    family: "reference",
    purpose:
      "Who may borrow under a lending product — resident individual, NRI, or a " +
      "non-individual entity. Not a duplicate of business_constitution, which " +
      "answers how a firm is constituted (Database/migrations/0015).",
    select: permits("master_data.read"),
    insert: permits("master_data.manage"),
    update: permits("master_data.manage"),
    delete: NEVER_DELETED,
  },
  {
    table: "security_type",
    family: "reference",
    purpose:
      "What secures a lending product — nothing, a mortgage, pledged gold, " +
      "hypothecated stock, a guarantee. Lender and RBI terminology, kept as " +
      "master data because the list grows with the products Amaze sources.",
    select: permits("master_data.read"),
    insert: permits("master_data.manage"),
    update: permits("master_data.manage"),
    delete: NEVER_DELETED,
  },
  {
    table: "requirement_applicability",
    family: "reference",
    purpose:
      "Mandatory / optional / not applicable. One shared vocabulary for both " +
      "loan_product.property_requirement_id and gst_requirement_id, which ask " +
      "the same question about different things.",
    select: permits("master_data.read"),
    insert: permits("master_data.manage"),
    update: permits("master_data.manage"),
    delete: NEVER_DELETED,
  },
  {
    table: "loan_product_borrower_type",
    family: "reference",
    purpose:
      "Which kinds of borrower a lending product is available to. Many-to-many, " +
      "because a product serves several and a column would force one.",
    select: permits("master_data.read"),
    insert: permits("master_data.manage"),
    update: permits("master_data.manage"),
    delete: permits("master_data.manage"),
    notes:
      "The one family of tables in this schema where delete is permitted. A " +
      "junction row carries no history of its own — the fact of record is the " +
      "product, and the edit is in the event log (ADR-005). Soft-deleting it " +
      "would make every consuming query filter forever for no reader's benefit.",
  },
  {
    table: "loan_product_employment_type",
    family: "reference",
    purpose:
      "Which income-source classifications a lending product accepts, reusing " +
      "the employment_type master data rather than a second vocabulary for the " +
      "same idea.",
    select: permits("master_data.read"),
    insert: permits("master_data.manage"),
    update: permits("master_data.manage"),
    delete: permits("master_data.manage"),
    notes: "Deletable for the same reason as loan_product_borrower_type.",
  },
  {
    table: "loan_product_business_constitution",
    family: "reference",
    purpose:
      "Which legal constitutions of a borrowing firm a lending product accepts. " +
      "Empty for a product no firm can take, which is an answer rather than a " +
      "missing row.",
    select: permits("master_data.read"),
    insert: permits("master_data.manage"),
    update: permits("master_data.manage"),
    delete: permits("master_data.manage"),
    notes: "Deletable for the same reason as loan_product_borrower_type.",
  },
  {
    table: "document_type",
    family: "reference",
    purpose:
      "The kinds of document AOS recognises. A table rather than an enum because " +
      "requirement templates key off it and adding a type must not be a migration " +
      "(ADR-025).",
    select: permits("master_data.read"),
    insert: permits("master_data.manage"),
    update: permits("master_data.manage"),
    delete: NEVER_DELETED,
  },
  {
    table: "operational_threshold",
    family: "reference",
    purpose:
      "Tunable day-counts — idle threshold per stage, offer-expiry warning lead time, " +
      "unverified-document age, default hold follow-up (ADR-025).",
    select: permits("master_data.read"),
    insert: internal(
      "Keys are a closed enum in `src/domain/settings/`, seeded by migration. Adding " +
        "a key is a code change, deliberately — that friction is what stops this " +
        "becoming the generic settings table ADR-025 refused.",
    ),
    update: permits("master_data.manage"),
    delete: internal(
      "Removing a key is a code change for the same reason. A threshold nobody wants " +
        "is set high, not deleted.",
    ),
    notes: "The value is editable at runtime; the key set is not. That is the whole point of the shape.",
  },
  {
    table: "rejection_reason",
    family: "reference",
    purpose:
      "Amaze's standardised rejection categories, which make rejections comparable " +
      "across banks that use different terminology (ADR-028).",
    select: permits("master_data.read"),
    insert: permits("master_data.manage"),
    update: permits("master_data.manage"),
    delete: NEVER_DELETED,
    notes: "Retired reasons set `active = false`. Existing submissions keep pointing at them.",
  },

  // ── Master Data Engine (Milestone 5) ─────────────────────────────────────
  {
    table: "customer_product",
    family: "reference",
    purpose:
      "Amaze's commercial grouping of loan products — Home Loan, Business Loan, " +
      "LAP, Personal. Promoted from loan_product.category free text (Database/" +
      "migrations/0012). Renamed from loan_category in Milestone 7.1 (ADR-033) " +
      "to match how office staff and telecallers already refer to it.",
    select: permits("master_data.read"),
    insert: permits("master_data.manage"),
    update: permits("master_data.manage"),
    delete: NEVER_DELETED,
  },
  {
    table: "employment_type",
    family: "reference",
    purpose:
      "A person's income-source classification. Converted from app.employment_type " +
      "(an enum since 0001) to master data: it drives requirement generation exactly " +
      "as document_type does, which is the ADR-025 test for table over enum.",
    select: permits("master_data.read"),
    insert: permits("master_data.manage"),
    update: permits("master_data.manage"),
    delete: NEVER_DELETED,
  },
  {
    table: "business_constitution",
    family: "reference",
    purpose:
      "How a borrowing firm is legally constituted — proprietorship, partnership, " +
      "private limited, and so on. Not modelled before Milestone 5.",
    select: permits("master_data.read"),
    insert: permits("master_data.manage"),
    update: permits("master_data.manage"),
    delete: NEVER_DELETED,
  },
  {
    table: "property_type",
    family: "reference",
    purpose:
      "What kind of property — apartment, plot, villa, commercial. Was free text " +
      "on property with no controlled vocabulary.",
    select: permits("master_data.read"),
    insert: permits("master_data.manage"),
    update: permits("master_data.manage"),
    delete: NEVER_DELETED,
  },
  {
    table: "property_ownership_type",
    family: "reference",
    purpose:
      "How title is held — freehold, leasehold, ancestral, power of attorney, joint. " +
      "Was free text on property with no controlled vocabulary.",
    select: permits("master_data.read"),
    insert: permits("master_data.manage"),
    update: permits("master_data.manage"),
    delete: NEVER_DELETED,
  },
  {
    table: "referral_source",
    family: "reference",
    purpose:
      "How a lead reached Amaze. Replaces the hardcoded <option> list that used to " +
      "live in the case-creation screen.",
    select: permits("master_data.read"),
    insert: permits("master_data.manage"),
    update: permits("master_data.manage"),
    delete: NEVER_DELETED,
  },
  {
    table: "district",
    family: "reference",
    purpose: "A district Amaze operates in or lends against, grouping cities.",
    select: permits("master_data.read"),
    insert: permits("master_data.manage"),
    update: permits("master_data.manage"),
    delete: NEVER_DELETED,
  },
  {
    table: "city",
    family: "reference",
    purpose:
      "A city Amaze operates in or lends against. Not yet referenced by " +
      "person.city / organisation.city / property.city, which remain free text " +
      "pending their own migration (Database/migrations/0012).",
    select: permits("master_data.read"),
    insert: permits("master_data.manage"),
    update: permits("master_data.manage"),
    delete: NEVER_DELETED,
  },

  // ── Banking work ─────────────────────────────────────────────────────────
  {
    table: "submission",
    family: "case-derived",
    purpose:
      "A case sent to one bank branch, carrying its own independent status (ADR-004). " +
      "This is where the real work lives.",
    select: permits("submission.read"),
    insert: permits("submission.create"),
    update: permits("submission.update_status"),
    delete: NEVER_DELETED,
    maskedColumns: [
      {
        column: "login_fee_amount",
        revealedBy: "commercial.view",
        maskedAs: "null-shaped placeholder — whether a fee was paid is visible, the figure is not",
      },
    ],
  },
  {
    table: "submission_query",
    family: "case-derived",
    purpose:
      "One query raised by a bank, with what was asked and what was sent. " +
      "`query_raised → under_process` is a loop and the single most common " +
      "real-world transition; without a row per pass, \"how many queries did this " +
      "branch raise?\" is answered with \"one\".",
    select: permits("submission.read"),
    insert: permits("submission.update_status"),
    update: permits("submission.update_status"),
    delete: NEVER_DELETED,
    notes:
      "Recording the answer is an update, not a new row: the question and its " +
      "answer are one exchange.",
  },
  {
    table: "offer",
    family: "case-derived",
    purpose:
      "What a bank came back with. Separate from submission because a bank revises " +
      "offers, and comparing the original against the revision is the conversation " +
      "you have with the customer.",
    select: permits("offer.read"),
    insert: permits("offer.record"),
    update: permits("offer.record", "offer.accept"),
    delete: NEVER_DELETED,
  },

  // ── Assets ───────────────────────────────────────────────────────────────
  {
    table: "property",
    family: "reference",
    purpose:
      "Collateral, or the property being purchased. Owned independently of any case: " +
      "the same property appears in a purchase, a later top-up and a balance transfer.",
    select: permits("property.read"),
    insert: permits("property.create"),
    update: permits("property.update", "property.merge"),
    delete: NEVER_DELETED,
  },
  {
    table: "employment",
    family: "reference",
    purpose:
      "A person's employer and employment type, which drives requirement generation " +
      "— and whose history matters when a bank asks about job stability.",
    select: permits("employment.read"),
    insert: permits("employment.record"),
    update: permits("employment.record"),
    delete: NEVER_DELETED,
  },
];

const TABLE_INDEX: ReadonlyMap<string, TableBinding> = new Map(
  TABLE_BINDINGS.map((binding) => [binding.table, binding]),
);

export function findTableBinding(table: string): TableBinding | undefined {
  return TABLE_INDEX.get(table);
}

export function tableNames(): readonly string[] {
  return TABLE_BINDINGS.map((binding) => binding.table);
}

/** Every permission named by any binding — used to prove no permission is orphaned. */
export function permissionsReferencedByTables(): ReadonlySet<string> {
  const referenced = new Set<string>();
  for (const binding of TABLE_BINDINGS) {
    for (const operation of [binding.select, binding.insert, binding.update, binding.delete]) {
      if (operation.kind === "permission") {
        for (const key of operation.anyOf) {
          referenced.add(key);
        }
      }
    }
    for (const masked of binding.maskedColumns ?? []) {
      referenced.add(masked.revealedBy);
    }
  }
  return referenced;
}

/**
 * Permissions that legitimately govern no table.
 *
 * These are capabilities rather than row access: they gate a screen, a computed
 * aggregate, or the ability to hand out access. Listed explicitly so that the
 * "no orphan permissions" test can be exact rather than approximate.
 */
export const NON_TABLE_PERMISSIONS: Record<string, string> = {
  "report.view":
    "Gates aggregate reporting. The aggregates are computed over rows the user may " +
    "already see, so it grants no additional row access.",
  "person.override_duplicate":
    "Gates an action at the moment of creation — proceeding past a duplicate warning " +
    "— rather than access to a row. The override itself is an event (BR-053).",
  "document.delete_version":
    "Granted to nobody and bound to no table: `document.delete` is `forbidden`. Kept " +
    "in the catalog so the decision is explicit rather than accidental.",
};

/** Does this role hold this permission at at least this scope? Pure; used by tests and the UI. */
export interface PermissionCheck {
  readonly permission: string;
  readonly scope: Scope;
  readonly roles: readonly Role[];
}
