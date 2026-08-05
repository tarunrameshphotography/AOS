/**
 * Permission scopes.
 *
 * Source of truth: PRD/Permissions.md, ADR-022, ADR-027
 *
 * A permission is an action *and* a scope (BR-064). An action alone has no
 * useful answer: "may they read cases?" is unanswerable, "may they read *which*
 * cases?" is not.
 *
 * Scopes are ordered — `all` ⊇ `team` ⊇ `own` — so every check is one
 * comparison rather than a set membership test per permission. This is what RLS
 * policies compile down to.
 */

export const SCOPES = ["own", "team", "all"] as const;

export type Scope = (typeof SCOPES)[number];

/**
 * Rank within the containment order. Higher includes lower.
 *
 * Kept as an explicit map rather than an array index so that adding a scope
 * forces a deliberate decision about where it sits, rather than inheriting a
 * position from list order — the mistake ADR-023 caught on case stages.
 */
const SCOPE_RANK: Record<Scope, number> = {
  own: 0,
  team: 1,
  all: 2,
};

/**
 * Does a held scope satisfy a required one?
 *
 * `satisfies("all", "own")` is true: someone who may read every case may
 * certainly read their own.
 */
export function scopeSatisfies(held: Scope, required: Scope): boolean {
  return SCOPE_RANK[held] >= SCOPE_RANK[required];
}

/** The widest of a set of scopes — a user holds the union of their roles' grants (BR-061). */
export function widestScope(scopes: readonly Scope[]): Scope | null {
  return scopes.reduce<Scope | null>(
    (widest, scope) =>
      widest === null || SCOPE_RANK[scope] > SCOPE_RANK[widest] ? scope : widest,
    null,
  );
}

/**
 * How `own` is defined for a given table.
 *
 * ADR-027 requires one definition per family rather than one per table, because
 * a per-table definition is invented at the moment each policy is written and
 * the definitions then disagree.
 */
export const SCOPE_FAMILIES = ["case-derived", "reference", "self"] as const;

export type ScopeFamily = (typeof SCOPE_FAMILIES)[number];

/**
 * What `own` means in each family. These strings are documentation with a
 * single home; the RLS predicates are generated from the same table bindings
 * that name the family, so the two cannot drift.
 */
export const SCOPE_FAMILY_DEFINITIONS: Record<ScopeFamily, string> = {
  "case-derived":
    "The row is reachable from a case the user owns or is a named participant on. " +
    "Reachability is via case_id, or via case_party / case_property for rows that " +
    "hang off a person, organisation or property (ADR-007 means a document belongs " +
    "to a person, not to the case that references it).",
  reference:
    "`own` is not offered. The row is not derived from any case, and narrowing it " +
    "would defeat the purpose of the table — recognition requires seeing everyone " +
    "(Product Principles #4). Every permission on these tables permits `all` only. " +
    "Which permission governs *writing* is a separate axis, stated per table: " +
    "master data is written under master_data.manage, the people-and-places " +
    "directory under its own create/update/merge permissions.",
  self: "The row belongs to the requesting user — user reading its own account and roles.",
};
