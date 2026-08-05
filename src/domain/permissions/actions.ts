/**
 * The permission catalog — every action AOS recognises.
 *
 * Source of truth: PRD/Permissions.md, ADR-022, ADR-026, ADR-027
 *
 * This file is the single definition. `role_permission` is seeded from it by
 * migration and RLS policies read that table; nothing is hand-written in SQL,
 * because two definitions of one rule always drift (ADR-022).
 *
 * The catalog is **derived from the entity list**, not accumulated from screens
 * (ADR-027). `tables.ts` binds every table to the permissions governing its
 * operations, and a test fails if any table or any permission is orphaned. That
 * is what makes the completeness claim checkable rather than aspirational.
 */

import type { Scope } from "./scopes.js";

/**
 * Where a permission is enforced.
 *
 * `row` — an RLS policy on the base table. The row is present or it is not.
 *
 * `column` — a masking expression in the view the client reads (ADR-026).
 * The row is visible; a field within it is not. Postgres RLS filters rows and
 * cannot express this, and column GRANTs are role privileges that do not
 * compose with `role_permission`, so masked views are the single mechanism.
 * Exactly two permissions are column-level and no others.
 */
export const PERMISSION_LEVELS = ["row", "column"] as const;

export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

/** Documentation grouping only. Carries no behaviour. */
export const PERMISSION_GROUPS = [
  "cases",
  "people-and-organisations",
  "documents",
  "banking",
  "work-and-communication",
  "sensitive",
  "administration",
] as const;

export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

export interface PermissionDefinition {
  /** `entity.action`, no abbreviations, no wildcards. */
  readonly key: string;
  readonly group: PermissionGroup;
  readonly level: PermissionLevel;
  /**
   * The scopes this permission may be granted at, widest last.
   *
   * `["all"]` alone is the sentinel for a permission that cannot be narrowed —
   * either because there is no row to scope against (`case.create`) or because
   * narrowing would defeat the table (`person.read`; see the `reference` family
   * in `scopes.ts`). Scope is still always present, which is what makes BR-064
   * literally true (ADR-027).
   */
  readonly permittedScopes: readonly Scope[];
  readonly description: string;
}

const ALL_SCOPES: readonly Scope[] = ["own", "team", "all"];
const ALL_ONLY: readonly Scope[] = ["all"];

export const PERMISSIONS: readonly PermissionDefinition[] = [
  // ── Cases ────────────────────────────────────────────────────────────────
  {
    key: "case.read",
    group: "cases",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description: "See a case and everything that hangs off it.",
  },
  {
    key: "case.create",
    group: "cases",
    level: "row",
    permittedScopes: ALL_ONLY,
    description:
      "Open a new case. A lead is a case (ADR-008), so this is the telecaller's " +
      "primary action. No row exists yet to scope against.",
  },
  {
    key: "case.update",
    group: "cases",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description:
      "Change a case's own fields and its party, property and requirement rows. " +
      "Stage movement is not covered here — stages move through transitions.",
  },
  {
    key: "case.assign",
    group: "cases",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description: "Change a case's accountable owner (BR-011). Always an event.",
  },
  {
    key: "case.hold",
    group: "cases",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description: "Place or lift a hold, with reason and follow-up date (ADR-021).",
  },
  {
    key: "case.mark_lost",
    group: "cases",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description: "End a case as lost, with a reason from the controlled list (BR-013).",
  },
  {
    key: "case.reopen",
    group: "cases",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description: "Return a lost case to the stage it was lost from.",
  },
  {
    key: "case.close",
    group: "cases",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description:
      "Close a disbursed case. Closing asserts the invoice is raised, which is why " +
      "it is Finance's and not the owner's.",
  },

  // ── People and organisations ─────────────────────────────────────────────
  {
    key: "person.read",
    group: "people-and-organisations",
    level: "row",
    permittedScopes: ALL_ONLY,
    description:
      "See a person and their identifiers, aliases and employment. Deliberately " +
      "not narrowable: a telecaller must be able to discover that the caller is an " +
      "existing customer, which is the product's central promise (Principle #4).",
  },
  {
    key: "person.create",
    group: "people-and-organisations",
    level: "row",
    permittedScopes: ALL_ONLY,
    description: "Record a new person. No row exists yet to scope against.",
  },
  {
    key: "person.update",
    group: "people-and-organisations",
    level: "row",
    permittedScopes: ALL_ONLY,
    description:
      "Amend a person, their identifiers, aliases, employment, referrer profile and " +
      "bank-contact relationships.",
  },
  {
    key: "person.merge",
    group: "people-and-organisations",
    level: "row",
    permittedScopes: ALL_ONLY,
    description:
      "Merge two people into one, leaving the loser as a redirecting tombstone " +
      "(BR-004). Reversible (BR-005), which is what makes restricting it tolerable.",
  },
  {
    key: "person.override_duplicate",
    group: "people-and-organisations",
    level: "row",
    permittedScopes: ALL_ONLY,
    description:
      "Create a person the system believes is a duplicate. Requires a reason and " +
      "writes an event (BR-053).",
  },
  {
    key: "organisation.read",
    group: "people-and-organisations",
    level: "row",
    permittedScopes: ALL_ONLY,
    description:
      "See an organisation, its aliases, its lender profile and its bank contacts. " +
      "Covers employers, borrowing firms, builders, banks and branches (ADR-014).",
  },
  {
    key: "organisation.create",
    group: "people-and-organisations",
    level: "row",
    permittedScopes: ALL_ONLY,
    description:
      "Record a new organisation. Users never do this explicitly — typing a name " +
      "resolves or creates one in the background (ADR-009).",
  },
  {
    key: "organisation.update",
    group: "people-and-organisations",
    level: "row",
    permittedScopes: ALL_ONLY,
    description:
      "Amend an organisation, its aliases and its bank contacts. Found missing by " +
      "the consistency audit — the catalog had create and merge but no update.",
  },
  {
    key: "organisation.merge",
    group: "people-and-organisations",
    level: "row",
    permittedScopes: ALL_ONLY,
    description:
      "Merge two organisations, following the same tombstone-and-alias rules as " +
      "people (BR-006). Near-matches are suggested, never auto-merged.",
  },
  {
    key: "property.read",
    group: "people-and-organisations",
    level: "row",
    permittedScopes: ALL_ONLY,
    description:
      "See a property. Not narrowable for the same reason as person: one property " +
      "appears across a purchase, a later top-up and a balance transfer, and " +
      "recognising that is the point.",
  },
  {
    key: "property.create",
    group: "people-and-organisations",
    level: "row",
    permittedScopes: ALL_ONLY,
    description:
      "Record a property. Duplicates are tolerated here — properties are found " +
      "through their case and their people, which are well identified.",
  },
  {
    key: "property.update",
    group: "people-and-organisations",
    level: "row",
    permittedScopes: ALL_ONLY,
    description: "Amend a property's address, valuation and document numbers.",
  },
  {
    key: "property.merge",
    group: "people-and-organisations",
    level: "row",
    permittedScopes: ALL_ONLY,
    description:
      "Merge two property records. Expected to be rare and requires an extra " +
      "confirmation — wrongly linking two properties has a financial consequence " +
      "far worse than a duplicate row (Identity Resolution Part 5).",
  },
  {
    key: "employment.read",
    group: "people-and-organisations",
    level: "row",
    permittedScopes: ALL_ONLY,
    description:
      "See a person's employment history. Employment type drives requirement " +
      "generation, so the login desk needs it on every file.",
  },
  {
    key: "employment.record",
    group: "people-and-organisations",
    level: "row",
    permittedScopes: ALL_ONLY,
    description:
      "Add or amend an employment relationship, including declared income. One " +
      "permission rather than create plus update: an employment row is corrected " +
      "far more often than a new one is genuinely added, and splitting them would " +
      "mean every role that holds one holds the other.",
  },

  // ── Documents and requirements ───────────────────────────────────────────
  {
    key: "document.read",
    group: "documents",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description:
      "See and download a document. Narrowable, unlike person: a document is the " +
      "sensitive artefact, and `own` reaches it through the cases that reference it.",
  },
  {
    key: "document.upload",
    group: "documents",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description:
      "Add a document, or a new version of one. Versions accumulate; nothing is " +
      "overwritten in place (BR-031).",
  },
  {
    key: "document.verify",
    group: "documents",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description:
      "Mark a document checked. Always attributed to a named human — the system " +
      "never verifies (BR-032).",
  },
  {
    key: "document.delete_version",
    group: "documents",
    level: "row",
    permittedScopes: ALL_ONLY,
    description:
      "Remove a document version. **Granted to nobody, deliberately.** Documents " +
      "are versioned and never overwritten (BR-031), and a replaced document may " +
      "be the one a bank already saw. Listed so the decision is explicit rather " +
      "than accidental.",
  },
  {
    key: "requirement.waive",
    group: "documents",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description:
      "Excuse a requirement, recording who, when and why (BR-035). A waiver sends " +
      "an incomplete file to a bank; safety comes from attribution, not rarity.",
  },

  // ── Banking ──────────────────────────────────────────────────────────────
  {
    key: "submission.read",
    group: "banking",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description:
      "See a case's submissions and their statuses — the grid that sits beneath the " +
      "case stage and makes the two axes obvious (ADR-004).",
  },
  {
    key: "submission.create",
    group: "banking",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description:
      "Send a file to a bank branch. A corrected file returning to the same branch " +
      "is a new submission, never a reset of the old one (Workflow.md).",
  },
  {
    key: "submission.update_status",
    group: "banking",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description:
      "Move a submission's status, including recording a rejection with its " +
      "standardised reason and the bank's own wording (ADR-028).",
  },
  {
    key: "offer.read",
    group: "banking",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description: "See what a bank came back with — amount, rate, tenure, conditions.",
  },
  {
    key: "offer.record",
    group: "banking",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description:
      "Enter or revise an offer against a submission. A revision is a new offer row: " +
      "comparing it against the original is the conversation with the customer.",
  },
  {
    key: "offer.accept",
    group: "banking",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description:
      "Record that the customer accepted an offer. At most one per submission " +
      "(BR-025); the unaccepted submissions then go to Withdrawn, not Rejected.",
  },

  // ── Work and communication ───────────────────────────────────────────────
  {
    key: "task.read",
    group: "work-and-communication",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description:
      "See tasks. At `own` this is the calling screen's work list; at `all` it is " +
      "how a manager sees what the team is carrying.",
  },
  {
    key: "task.create",
    group: "work-and-communication",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description:
      "Raise a task for oneself. Assigning it to somebody else is `task.assign`, " +
      "deliberately separate.",
  },
  {
    key: "task.update",
    group: "work-and-communication",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description:
      "Amend or complete a task. Tasks are never deleted — a deleted task hides the " +
      "fact that work was dropped (BR-041).",
  },
  {
    key: "task.assign",
    group: "work-and-communication",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description: "Give a task to somebody else. Every task has exactly one assignee (BR-040).",
  },
  {
    key: "communication.read",
    group: "work-and-communication",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description:
      "See logged calls, WhatsApp, email and meetings. Found missing by the audit — " +
      "roles could log a communication but nothing said who could read one.",
  },
  {
    key: "communication.log",
    group: "work-and-communication",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description:
      "Record an exchange with a person. Logged against both the person and the " +
      "case, so a person's full history is visible from their profile.",
  },
  {
    key: "note.read",
    group: "work-and-communication",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description: "Read internal commentary on a case. Found missing by the audit.",
  },
  {
    key: "note.create",
    group: "work-and-communication",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description:
      "Write internal commentary, immutable after a short edit window. Notes are not " +
      "a place for structured facts — if something is written repeatedly, it wants " +
      "a field (Principle #11).",
  },

  // ── Sensitive ────────────────────────────────────────────────────────────
  {
    key: "identifier.view_full",
    group: "sensitive",
    level: "column",
    permittedScopes: ALL_ONLY,
    description:
      "See an unmasked identifier value — full PAN rather than `ABCxxxxx1F`. " +
      "Column-level: the person row is visible either way (ADR-026). The only " +
      "permission whose denial is itself an event, because revealing one value is " +
      "a per-record disclosure decision rather than a whole-surface one.",
  },
  {
    key: "commercial.view",
    group: "sensitive",
    level: "column",
    permittedScopes: ALL_ONLY,
    description:
      "See money the customer never sees: commission terms, referrer payouts, " +
      "login fees, invoice figures. Column-level (ADR-026) — the case, submission " +
      "and referrer rows are visible without it.",
  },
  {
    key: "event.view",
    group: "sensitive",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description:
      "Read the audit log. Row-level rather than column-level: an event is either " +
      "yours to see or it is not.",
  },

  // ── Administration ───────────────────────────────────────────────────────
  {
    key: "user.read",
    group: "administration",
    level: "row",
    permittedScopes: ALL_SCOPES,
    description:
      "See who holds an account and which roles they hold. Held at `all` by every " +
      "role: colleagues' names appear on every case, and `own` alone would make a " +
      "case owner unrenderable.",
  },
  {
    key: "user.manage",
    group: "administration",
    level: "row",
    permittedScopes: ALL_ONLY,
    description:
      "Create and deactivate accounts. Never delete — a departed employee's name " +
      "must survive on every case they touched (BR-062).",
  },
  {
    key: "role.assign",
    group: "administration",
    level: "row",
    permittedScopes: ALL_ONLY,
    description:
      "Grant and revoke roles. Assignment is runtime data, never a migration " +
      "(ADR-022).",
  },
  {
    key: "master_data.read",
    group: "administration",
    level: "row",
    permittedScopes: ALL_ONLY,
    description:
      "Read reference tables — loan products, bank products, document types, " +
      "rejection reasons, operational thresholds, the permission catalog itself. " +
      "Held by every role. It exists so that no table is bound to a null " +
      "permission: 'everyone may read this' is a decision and should be written " +
      "down as one (ADR-027).",
  },
  {
    key: "master_data.manage",
    group: "administration",
    level: "row",
    permittedScopes: ALL_ONLY,
    description:
      "Maintain reference tables — add a bank, a branch, a bank product, a " +
      "document type, a rejection reason. Not a licence to alter operational " +
      "records.",
  },
  {
    key: "report.view",
    group: "administration",
    level: "row",
    permittedScopes: ALL_ONLY,
    description: "Read aggregate reporting. Aggregates are computed over rows the user may see.",
  },
];

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

const PERMISSION_INDEX: ReadonlyMap<string, PermissionDefinition> = new Map(
  PERMISSIONS.map((permission) => [permission.key, permission]),
);

export function findPermission(key: string): PermissionDefinition | undefined {
  return PERMISSION_INDEX.get(key);
}

export function permissionKeys(): readonly string[] {
  return PERMISSIONS.map((permission) => permission.key);
}

/** The two column-level permissions (ADR-026). Asserted to stay two by test. */
export function columnLevelPermissions(): readonly PermissionDefinition[] {
  return PERMISSIONS.filter((permission) => permission.level === "column");
}
