/**
 * The schema and the permission bindings must name the same tables.
 *
 * ADR-027's claim — "a table with no binding is a test failure, not an
 * unprotected table that ships" — is only true if something compares the two
 * lists. `tables.ts` proves its own internal consistency; this proves it against
 * the migrations, which is where tables actually come into existence.
 *
 * It reads the SQL as text rather than connecting to a database. That is enough
 * for the question being asked (which tables exist?), needs no running Postgres
 * in CI, and fails on the realistic mistake: someone adds `create table` and
 * forgets the binding.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TABLE_BINDINGS } from "./tables.js";

const migrationsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../Database/migrations",
);

function migrationSql(): string {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(join(migrationsDir, name), "utf8"))
    .join("\n");
}

/** Table names from `create table <name> (`, ignoring anything inside a comment. */
function tablesCreatedByMigrations(sql: string): ReadonlySet<string> {
  const withoutLineComments = sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

  const found = new Set<string>();
  const pattern = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutLineComments)) !== null) {
    if (match[1] !== undefined) {
      found.add(match[1]);
    }
  }
  return found;
}

const sql = migrationSql();
const created = tablesCreatedByMigrations(sql);
const bound = new Set(TABLE_BINDINGS.map((binding) => binding.table));

describe("schema coverage", () => {
  it("finds the migrations at all", () => {
    expect(created.size).toBeGreaterThan(20);
  });

  it("binds every table the migrations create — no orphan tables (ADR-027, BR-065)", () => {
    const unbound = [...created].filter((table) => !bound.has(table)).sort();
    expect(
      unbound,
      `These tables exist in the schema with no permission binding. Add them to ` +
        `src/domain/permissions/tables.ts, or the schema ships a table nobody ` +
        `decided how to protect.`,
    ).toEqual([]);
  });

  it("creates every table the bindings name — no bindings for tables that do not exist", () => {
    const missing = [...bound].filter((table) => !created.has(table)).sort();
    expect(
      missing,
      `These tables are bound in tables.ts but no migration creates them. Either ` +
        `the migration is missing or the binding is stale.`,
    ).toEqual([]);
  });

  it("enables row level security on every table it creates", () => {
    // 0010 enables RLS from an array literal, so the check is that every
    // created table is named there.
    for (const table of created) {
      expect(
        sql.includes(`'${table}'`),
        `${table} is not listed in the RLS enablement block in ` +
          `0010_security_defaults.sql, so it would ship with no row security.`,
      ).toBe(true);
    }
  });

  it("gives every table a comment saying why it exists", () => {
    for (const table of created) {
      expect(
        sql.includes(`comment on table ${table} is`),
        `${table} has no COMMENT ON TABLE. Every table must answer: why does it ` +
          `exist, what business rule requires it, which ADR introduced it, which ` +
          `PRD depends on it.`,
      ).toBe(true);
    }
  });
});
