/**
 * Drift detection between the catalog and the migration that seeds it.
 *
 * This is the test that makes ADR-022's "never hand-written in SQL" enforceable.
 * Editing `roles.ts` without regenerating the migration fails here, which is the
 * only moment anybody would notice before the database and the domain layer
 * disagreed about who may do what.
 *
 * Regenerate with `npm run seed:permissions`.
 *
 * The migration is written as a file snapshot rather than by a bespoke script:
 * vitest already knows how to write a file, compare it, and update it on
 * request, and it does so identically on every platform. A hand-rolled
 * generator would need its own argument parsing and its own cross-platform
 * environment-variable dance to do the same job worse.
 */

import { describe, expect, it } from "vitest";

import { SEED_MIGRATION_PATH, buildPermissionSeedSql } from "./seed.js";

const generated = buildPermissionSeedSql();

// Relative to this test file, which is where toMatchFileSnapshot resolves from.
const migrationPath = `../../../${SEED_MIGRATION_PATH}`;

describe("the generated permission seed", () => {
  it("matches the checked-in migration exactly", async () => {
    // Fails with a diff if roles.ts changed and the migration did not.
    // `npm run seed:permissions` rewrites it.
    await expect(generated).toMatchFileSnapshot(migrationPath);
  });

  it("emits a statement for each of the three seeded tables", () => {
    // A cheap shape check, so a broken generator fails here rather than at
    // `psql` time with a syntax error nobody can attribute.
    expect(generated).toContain(
      "insert into permission (key, permission_group, level, description)",
    );
    expect(generated).toContain("insert into role_permission (role, permission, scope)");
    expect(generated).toContain("insert into operational_threshold (key, value_days, description)");
  });

  it("reconciles rather than appends, so a revoked grant actually disappears", () => {
    // Without the deletes, removing a permission from roles.ts would leave the
    // grant live in the database — a revocation that silently did nothing is
    // the worst possible failure for this file.
    expect(generated).toContain("delete from permission");
    expect(generated).toContain("delete from role_permission");
  });

  it("escapes quotes in descriptions rather than producing broken SQL", () => {
    // Every apostrophe inside a literal must be doubled. An odd count of single
    // quotes on a value line means one was not.
    for (const line of generated.split("\n")) {
      if (!line.startsWith("  (")) {
        continue;
      }
      const quotes = (line.match(/'/g) ?? []).length;
      expect(quotes % 2, `unbalanced quotes: ${line}`).toBe(0);
    }
  });
});
