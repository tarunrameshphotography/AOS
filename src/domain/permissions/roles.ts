/**
 * Roles and their grants.
 *
 * Source of truth: PRD/Permissions.md, ADR-022, ADR-027
 *
 * A role is a bundle of permissions, assigned as runtime data. A user holds many
 * roles and receives the **union** of their grants (BR-061) — at this size people
 * wear several hats, and two accounts for one human is how audit trails start
 * lying.
 *
 * Every grant is written out in full. There is no wildcard notation and no
 * "everything the telecaller has, plus" inheritance in the data, because a
 * shorthand makes "who can assign tasks?" unanswerable by reading the file. The
 * prose in `Permissions.md` may describe a role as extending another; this file
 * is the enumeration that describes it exactly.
 */

import type { Scope } from "./scopes.js";

export const ROLES = ["telecaller", "login_executive", "manager", "finance", "admin"] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  telecaller: "Telecaller",
  login_executive: "Login Executive",
  manager: "Manager",
  finance: "Finance",
  admin: "Admin",
};

export interface Grant {
  readonly permission: string;
  readonly scope: Scope;
}

/**
 * Grants held by each role, enumerated.
 *
 * These rows are seeded into `role_permission` by migration. RLS policies read
 * that table; they never restate this list (ADR-022).
 */
export const ROLE_GRANTS: Record<Role, readonly Grant[]> = {
  /**
   * Works a call list. Creates leads, talks to people, books appointments.
   *
   * The shape worth noticing: **cases are `own`, people are `all`.** A telecaller
   * must be able to discover that the caller is an existing customer — that
   * recognition is the core promise of the product (Principle #4). What they
   * cannot do is browse a colleague's cases.
   *
   * Not held: `document.verify`, `requirement.waive`, `identifier.view_full`,
   * `commercial.view`, `event.view`.
   */
  telecaller: [
    { permission: "case.read", scope: "own" },
    { permission: "case.create", scope: "all" },
    { permission: "case.update", scope: "own" },
    { permission: "case.hold", scope: "own" },
    { permission: "case.mark_lost", scope: "own" },
    { permission: "case.reopen", scope: "own" },

    { permission: "person.read", scope: "all" },
    { permission: "person.create", scope: "all" },
    { permission: "person.update", scope: "all" },
    { permission: "organisation.read", scope: "all" },
    { permission: "organisation.create", scope: "all" },
    { permission: "organisation.update", scope: "all" },
    { permission: "property.read", scope: "all" },
    { permission: "employment.read", scope: "all" },
    { permission: "employment.record", scope: "all" },

    { permission: "document.read", scope: "own" },
    { permission: "document.upload", scope: "own" },

    { permission: "submission.read", scope: "own" },
    { permission: "offer.read", scope: "own" },

    { permission: "task.read", scope: "own" },
    { permission: "task.create", scope: "own" },
    { permission: "task.update", scope: "own" },
    { permission: "communication.read", scope: "own" },
    { permission: "communication.log", scope: "own" },
    { permission: "note.read", scope: "own" },
    { permission: "note.create", scope: "own" },

    { permission: "user.read", scope: "all" },
    { permission: "master_data.read", scope: "all" },
  ],

  /**
   * Prepares files and deals with banks.
   *
   * `case.read:all` is necessary rather than generous — the login desk works
   * whatever file is in front of it, regardless of who sourced the lead. The
   * annotation permissions follow it up to `all` for the same reason: a desk that
   * may read a colleague's case but not leave a note on it will use WhatsApp
   * instead, and the record is lost.
   */
  login_executive: [
    { permission: "case.read", scope: "all" },
    { permission: "case.create", scope: "all" },
    // ADR-027, flagged there as the engineer's call rather than the business's:
    // a desk holding document.verify and submission.create at `all` but unable to
    // correct the requested amount on the file it is submitting is incoherent.
    { permission: "case.update", scope: "all" },
    { permission: "case.hold", scope: "own" },
    { permission: "case.mark_lost", scope: "own" },
    { permission: "case.reopen", scope: "own" },

    { permission: "person.read", scope: "all" },
    { permission: "person.create", scope: "all" },
    { permission: "person.update", scope: "all" },
    { permission: "organisation.read", scope: "all" },
    { permission: "organisation.create", scope: "all" },
    { permission: "organisation.update", scope: "all" },
    { permission: "property.read", scope: "all" },
    { permission: "property.create", scope: "all" },
    { permission: "property.update", scope: "all" },
    { permission: "employment.read", scope: "all" },
    { permission: "employment.record", scope: "all" },

    { permission: "document.read", scope: "all" },
    { permission: "document.upload", scope: "all" },
    { permission: "document.verify", scope: "all" },
    { permission: "requirement.waive", scope: "all" },

    { permission: "submission.read", scope: "all" },
    { permission: "submission.create", scope: "all" },
    { permission: "submission.update_status", scope: "all" },
    { permission: "offer.read", scope: "all" },
    { permission: "offer.record", scope: "all" },
    // Derived, not stated by the business: `Workflow.md` requires that the
    // unaccepted submissions go to Withdrawn once a customer picks a bank, which
    // is unreachable if nobody may accept an offer. Flagged in the matrix.
    { permission: "offer.accept", scope: "all" },

    { permission: "task.read", scope: "own" },
    { permission: "task.create", scope: "own" },
    { permission: "task.update", scope: "own" },
    { permission: "communication.read", scope: "all" },
    { permission: "communication.log", scope: "all" },
    { permission: "note.read", scope: "all" },
    { permission: "note.create", scope: "all" },

    { permission: "identifier.view_full", scope: "all" },

    { permission: "user.read", scope: "all" },
    { permission: "master_data.read", scope: "all" },
  ],

  /**
   * Sees everything operational, assigns work, resolves identity problems.
   *
   * Not `case.close` — that is Finance, because closing asserts the invoice is
   * raised. Not `commercial.view` by default; see the open question in
   * `Permissions.md`, which the derivation has now sharpened (a Manager sets
   * referrer commission terms through `person.update` but cannot read them back).
   */
  manager: [
    { permission: "case.read", scope: "all" },
    { permission: "case.create", scope: "all" },
    { permission: "case.update", scope: "all" },
    { permission: "case.assign", scope: "all" },
    { permission: "case.hold", scope: "all" },
    { permission: "case.mark_lost", scope: "all" },
    { permission: "case.reopen", scope: "all" },

    { permission: "person.read", scope: "all" },
    { permission: "person.create", scope: "all" },
    { permission: "person.update", scope: "all" },
    { permission: "person.merge", scope: "all" },
    { permission: "person.override_duplicate", scope: "all" },
    { permission: "organisation.read", scope: "all" },
    { permission: "organisation.create", scope: "all" },
    { permission: "organisation.update", scope: "all" },
    { permission: "organisation.merge", scope: "all" },
    { permission: "property.read", scope: "all" },
    { permission: "property.create", scope: "all" },
    { permission: "property.update", scope: "all" },
    { permission: "property.merge", scope: "all" },
    { permission: "employment.read", scope: "all" },
    { permission: "employment.record", scope: "all" },

    { permission: "document.read", scope: "all" },
    { permission: "document.upload", scope: "all" },
    { permission: "document.verify", scope: "all" },
    { permission: "requirement.waive", scope: "all" },

    { permission: "submission.read", scope: "all" },
    { permission: "submission.create", scope: "all" },
    { permission: "submission.update_status", scope: "all" },
    { permission: "offer.read", scope: "all" },
    { permission: "offer.record", scope: "all" },
    { permission: "offer.accept", scope: "all" },

    { permission: "task.read", scope: "all" },
    { permission: "task.create", scope: "all" },
    { permission: "task.update", scope: "all" },
    { permission: "task.assign", scope: "all" },
    { permission: "communication.read", scope: "all" },
    { permission: "communication.log", scope: "all" },
    { permission: "note.read", scope: "all" },
    { permission: "note.create", scope: "all" },

    { permission: "identifier.view_full", scope: "all" },
    { permission: "event.view", scope: "all" },

    { permission: "user.read", scope: "all" },
    { permission: "master_data.read", scope: "all" },
    { permission: "report.view", scope: "all" },
  ],

  /**
   * Money. Deliberately narrow elsewhere.
   *
   * `person.read` and `organisation.read` are here although `Permissions.md` did
   * not list them: `case.read:all` renders a case with no applicant name without
   * them, which is not a usable screen. Derived during the ADR-027 sweep and
   * flagged in the matrix.
   */
  finance: [
    { permission: "case.read", scope: "all" },
    { permission: "case.close", scope: "all" },

    { permission: "person.read", scope: "all" },
    { permission: "organisation.read", scope: "all" },

    { permission: "submission.read", scope: "all" },
    { permission: "offer.read", scope: "all" },

    { permission: "commercial.view", scope: "all" },

    { permission: "user.read", scope: "all" },
    { permission: "master_data.read", scope: "all" },
    { permission: "report.view", scope: "all" },
  ],

  /**
   * Runs the system, not the business.
   *
   * `Permissions.md` closed with the prose wildcard "all read permissions at
   * `all`". ADR-027 requires that be enumerated, and enumerating it forces a
   * question the wildcard hid: **which reads are administering the system, and
   * which are reading the customers?**
   *
   * The line drawn here is *structure, not content*. Admin may see that a case
   * exists, who owns it, which stage it is at, and what happened to it — enough
   * to answer "why can this user not see that case?". Admin may not open the
   * customer's documents, calls or notes.
   *
   * Excluded deliberately: `identifier.view_full` and `commercial.view` (ADR-027),
   * and — added by this derivation — `document.read`, `communication.read` and
   * `note.read`. Excluding the first two while granting `document.read` would be
   * theatre: the PAN card image is in the document store, so a masked PAN column
   * would protect nothing.
   *
   * An admin who needs to work cases holds a second role explicitly. That is what
   * multiple roles are for, and it leaves a trail.
   */
  admin: [
    { permission: "case.read", scope: "all" },
    { permission: "person.read", scope: "all" },
    { permission: "organisation.read", scope: "all" },
    { permission: "property.read", scope: "all" },
    { permission: "employment.read", scope: "all" },
    { permission: "submission.read", scope: "all" },
    { permission: "offer.read", scope: "all" },
    { permission: "task.read", scope: "all" },

    { permission: "event.view", scope: "all" },

    { permission: "user.read", scope: "all" },
    { permission: "user.manage", scope: "all" },
    { permission: "role.assign", scope: "all" },
    { permission: "master_data.read", scope: "all" },
    { permission: "master_data.manage", scope: "all" },
    { permission: "report.view", scope: "all" },
  ],
};

/**
 * Permissions that exist in the catalog and are held by nobody, with the reason.
 *
 * An unassigned permission is either a deliberate abstention or an oversight, and
 * the difference has to be written down or the next reader cannot tell. A test
 * asserts this list matches reality exactly, so an accidentally orphaned
 * permission fails the build rather than shipping.
 */
export const DELIBERATELY_UNASSIGNED: Record<string, string> = {
  "document.delete_version":
    "Documents are versioned and never overwritten (BR-031). A replaced document " +
    "may be the one a bank already saw. Kept in the catalog so the decision is " +
    "explicit rather than accidental; recommendation is to leave it unassigned.",
};

/** Every grant held by any of the given roles — the union a user actually gets (BR-061). */
export function grantsForRoles(roles: readonly Role[]): readonly Grant[] {
  return roles.flatMap((role) => ROLE_GRANTS[role]);
}
