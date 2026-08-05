/**
 * The permission seed, generated from the catalog.
 *
 * Source of truth: ADR-022, ADR-025
 *
 * ADR-022 says the catalog is defined once in `src/domain/permissions/` and the
 * database is seeded from it by migration — "never hand-written in SQL, or the
 * two definitions will drift". Hand-writing a hundred and fifty `insert`
 * statements would be exactly the drift it forbids, so the migration is this
 * function's output.
 *
 * `seed.test.ts` asserts the checked-in migration matches what this produces.
 * Editing `roles.ts` without regenerating fails the build, which is the property
 * that makes "one rule, one implementation" true rather than intended.
 */

import { PERMISSIONS } from "./actions.js";
import { ROLES, ROLE_GRANTS } from "./roles.js";
import { THRESHOLD_DEFAULTS, THRESHOLD_KEYS } from "../settings/thresholds.js";

/** Postgres string literal. Doubling the quote is the whole of the escaping rule. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Collapse a description to one line — it becomes a column value, not prose. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export const SEED_MIGRATION_PATH = "Database/migrations/0008_seed_permissions.sql";

export function buildPermissionSeedSql(): string {
  const lines: string[] = [];

  lines.push(
    "-- ===========================================================================",
    "-- 0008 — Permission catalog, role grants, and operational thresholds",
    "--",
    "-- GENERATED FILE. Do not edit by hand.",
    "--",
    "-- Produced by buildPermissionSeedSql() in src/domain/permissions/seed.ts from",
    "-- the catalog in actions.ts, the grants in roles.ts, and the threshold keys in",
    "-- settings/thresholds.ts. Those files are the single definition (ADR-022,",
    "-- ADR-025); this migration is their projection into the database, which is",
    "-- where RLS can read them.",
    "--",
    "-- To change a grant: edit roles.ts, run `npm run seed:permissions`, commit both.",
    "-- seed.test.ts fails if this file and the catalog disagree.",
    "-- ===========================================================================",
    "",
    "-- Idempotent: re-running reconciles the database with the catalog rather than",
    "-- appending to it. A grant removed from roles.ts must disappear here too, or",
    "-- revoking a permission would require a hand-written migration — which is the",
    "-- drift ADR-022 exists to prevent.",
    "",
    "-- ---------------------------------------------------------------------------",
    "-- permission — the catalog",
    "-- ---------------------------------------------------------------------------",
    "",
    "insert into permission (key, permission_group, level, description) values",
  );

  const permissionRows = PERMISSIONS.map(
    (permission) =>
      `  (${quote(permission.key)}, ${quote(permission.group)}, ` +
      `${quote(permission.level)}, ${quote(oneLine(permission.description))})`,
  );
  lines.push(permissionRows.join(",\n") + "\non conflict (key) do update set");
  lines.push(
    "  permission_group = excluded.permission_group,",
    "  level            = excluded.level,",
    "  description      = excluded.description;",
    "",
    "-- ---------------------------------------------------------------------------",
    "-- role_permission — who holds what, at which scope",
    "--",
    "-- Grants are reconciled BEFORE stale permissions are removed. role_permission",
    "-- carries a foreign key to permission, so deleting a withdrawn permission",
    "-- while a grant still references it would fail the migration — and a seed that",
    "-- only works on an empty database is not a seed.",
    "-- ---------------------------------------------------------------------------",
    "",
    "insert into role_permission (role, permission, scope) values",
  );

  const grantRows = ROLES.flatMap((role) =>
    ROLE_GRANTS[role].map(
      (grant) =>
        `  (${quote(role)}, ${quote(grant.permission)}, ${quote(grant.scope)})`,
    ),
  );
  lines.push(grantRows.join(",\n") + "\non conflict (role, permission) do update set");
  lines.push(
    "  scope = excluded.scope;",
    "",
    "delete from role_permission",
    " where (role, permission) not in (",
    ROLES.flatMap((role) =>
      ROLE_GRANTS[role].map(
        (grant) => `       (${quote(role)}, ${quote(grant.permission)})`,
      ),
    ).join(",\n"),
    "     );",
    "",
    "-- Now the withdrawn permissions themselves, with no grants left pointing at",
    "-- them.",
    "delete from permission",
    " where key not in (",
    PERMISSIONS.map((permission) => `       ${quote(permission.key)}`).join(",\n"),
    "     );",
    "",
    "-- ---------------------------------------------------------------------------",
    "-- operational_threshold — keys are code, values are data (ADR-025)",
    "--",
    "-- The insert is deliberately NOT an upsert of the value: a threshold someone",
    "-- tuned in production must survive a redeploy. Only the key set is reconciled.",
    "-- ---------------------------------------------------------------------------",
    "",
    "insert into operational_threshold (key, value_days, description) values",
  );

  const thresholdRows = THRESHOLD_KEYS.map(
    (key) =>
      `  (${quote(key)}, ${THRESHOLD_DEFAULTS[key]}, ${quote(describeThreshold(key))})`,
  );
  lines.push(thresholdRows.join(",\n") + "\non conflict (key) do nothing;");
  lines.push(
    "",
    "delete from operational_threshold",
    " where key not in (",
    THRESHOLD_KEYS.map((key) => `       ${quote(key)}`).join(",\n"),
    "     );",
    "",
  );

  return lines.join("\n");
}

function describeThreshold(key: string): string {
  if (key.startsWith("idle_days.")) {
    const stage = key.slice("idle_days.".length).replace(/_/g, " ");
    return `Days a case may sit in "${stage}" before its health degrades.`;
  }
  switch (key) {
    case "offer_expiry_warning_days":
      return "Days before an offer expires at which a task is raised to the case owner.";
    case "unverified_document_age_days":
      return "Days a document may sit received-but-unverified before case health degrades.";
    case "default_hold_follow_up_days":
      return "Default follow-up date offered when a case is put on hold.";
    default:
      return key;
  }
}
