/**
 * These tests are what make ADR-027 enforced rather than aspirational.
 *
 * "No orphan entities, no orphan permissions, no missing security model" is a
 * claim that decays the moment someone adds a table in a hurry. Stated as a
 * test, it fails the build instead.
 */

import { describe, expect, it } from "vitest";

import {
  DELIBERATELY_UNASSIGNED,
  NON_TABLE_PERMISSIONS,
  PERMISSIONS,
  ROLES,
  ROLE_GRANTS,
  SCOPES,
  TABLE_BINDINGS,
  columnLevelPermissions,
  effectivePermissions,
  findPermission,
  hasPermission,
  permissionsReferencedByTables,
  scopeSatisfies,
  widestScope,
  type Role,
} from "./index.js";

const permissionKeySet = new Set(PERMISSIONS.map((p) => p.key));
const grantedKeys = new Set(
  ROLES.flatMap((role) => ROLE_GRANTS[role].map((grant) => grant.permission)),
);

describe("scope ordering", () => {
  it("orders all ⊇ team ⊇ own", () => {
    expect(scopeSatisfies("all", "own")).toBe(true);
    expect(scopeSatisfies("all", "team")).toBe(true);
    expect(scopeSatisfies("team", "own")).toBe(true);
    expect(scopeSatisfies("own", "team")).toBe(false);
    expect(scopeSatisfies("team", "all")).toBe(false);
  });

  it("is reflexive at every scope", () => {
    for (const scope of SCOPES) {
      expect(scopeSatisfies(scope, scope)).toBe(true);
    }
  });

  it("takes the widest of a union, which is how multiple roles combine (BR-061)", () => {
    expect(widestScope(["own", "all", "team"])).toBe("all");
    expect(widestScope(["own"])).toBe("own");
    expect(widestScope([])).toBeNull();
  });
});

describe("the catalog", () => {
  it("has no duplicate keys", () => {
    expect(permissionKeySet.size).toBe(PERMISSIONS.length);
  });

  it("names every permission entity.action, with no wildcards or abbreviations", () => {
    for (const permission of PERMISSIONS) {
      expect(permission.key).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(permission.key).not.toContain("*");
    }
  });

  it("gives every permission at least one scope — an action without a scope is not a permission (BR-064)", () => {
    for (const permission of PERMISSIONS) {
      expect(permission.permittedScopes.length).toBeGreaterThan(0);
      for (const scope of permission.permittedScopes) {
        expect(SCOPES).toContain(scope);
      }
    }
  });

  it("uses the sentinel `all` alone where narrowing is impossible (ADR-027)", () => {
    // A permission that cannot be narrowed is still scoped; it simply permits
    // one scope. The sentinel is never `own` or `team` alone — that would be a
    // permission nobody could hold at full breadth.
    for (const permission of PERMISSIONS) {
      expect(permission.permittedScopes).toContain("all");
    }
  });

  it("has exactly two column-level permissions, and they are the ones ADR-026 names", () => {
    expect(columnLevelPermissions().map((p) => p.key).sort()).toEqual([
      "commercial.view",
      "identifier.view_full",
    ]);
  });

  it("explains every permission", () => {
    for (const permission of PERMISSIONS) {
      expect(permission.description.length).toBeGreaterThan(20);
    }
  });
});

describe("no orphan permissions", () => {
  it("grants every permission to at least one role, or records why not", () => {
    for (const permission of PERMISSIONS) {
      if (grantedKeys.has(permission.key)) {
        continue;
      }
      expect(
        DELIBERATELY_UNASSIGNED[permission.key],
        `${permission.key} is granted to nobody and no reason is recorded. ` +
          `Either grant it, or add it to DELIBERATELY_UNASSIGNED with the reasoning.`,
      ).toBeDefined();
    }
  });

  it("records no reason for a permission that is in fact granted", () => {
    for (const key of Object.keys(DELIBERATELY_UNASSIGNED)) {
      expect(grantedKeys.has(key), `${key} is documented as unassigned but is granted.`).toBe(
        false,
      );
    }
  });

  it("binds every permission to a table, or records why it governs none", () => {
    const referenced = permissionsReferencedByTables();
    for (const permission of PERMISSIONS) {
      if (referenced.has(permission.key)) {
        continue;
      }
      expect(
        NON_TABLE_PERMISSIONS[permission.key],
        `${permission.key} governs no table and no reason is recorded.`,
      ).toBeDefined();
    }
  });

  it("records no exemption for a permission that does govern a table", () => {
    const referenced = permissionsReferencedByTables();
    for (const key of Object.keys(NON_TABLE_PERMISSIONS)) {
      expect(
        referenced.has(key),
        `${key} is documented as governing no table, but a binding names it.`,
      ).toBe(false);
    }
  });
});

describe("no orphan tables", () => {
  it("has no duplicate table names", () => {
    expect(new Set(TABLE_BINDINGS.map((t) => t.table)).size).toBe(TABLE_BINDINGS.length);
  });

  it("binds all four operations on every table — a table with no binding is a failure, not an unprotected table", () => {
    for (const binding of TABLE_BINDINGS) {
      for (const [name, operation] of Object.entries({
        select: binding.select,
        insert: binding.insert,
        update: binding.update,
        delete: binding.delete,
      })) {
        expect(operation, `${binding.table}.${name} has no binding`).toBeDefined();
        if (operation.kind === "permission") {
          expect(operation.anyOf.length, `${binding.table}.${name} permits nothing`).toBeGreaterThan(
            0,
          );
        } else {
          expect(
            operation.reason.length,
            `${binding.table}.${name} is ${operation.kind} without a reason`,
          ).toBeGreaterThan(20);
        }
      }
    }
  });

  it("names only permissions that exist in the catalog", () => {
    for (const binding of TABLE_BINDINGS) {
      for (const operation of [binding.select, binding.insert, binding.update, binding.delete]) {
        if (operation.kind !== "permission") {
          continue;
        }
        for (const key of operation.anyOf) {
          expect(
            permissionKeySet.has(key),
            `${binding.table} names unknown permission ${key}`,
          ).toBe(true);
        }
      }
    }
  });

  it("makes every table answer why it exists", () => {
    for (const binding of TABLE_BINDINGS) {
      expect(binding.purpose.length, `${binding.table} does not say why it exists`).toBeGreaterThan(
        30,
      );
    }
  });

  it("reveals masked columns only through a column-level permission (ADR-026)", () => {
    const columnLevel = new Set(columnLevelPermissions().map((p) => p.key));
    for (const binding of TABLE_BINDINGS) {
      for (const masked of binding.maskedColumns ?? []) {
        expect(
          columnLevel.has(masked.revealedBy),
          `${binding.table}.${masked.column} is revealed by ${masked.revealedBy}, ` +
            `which is not a column-level permission.`,
        ).toBe(true);
        expect(masked.maskedAs.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("grants", () => {
  it("names only permissions that exist, at scopes that permission allows", () => {
    for (const role of ROLES) {
      for (const grant of ROLE_GRANTS[role]) {
        const definition = findPermission(grant.permission);
        expect(definition, `${role} is granted unknown permission ${grant.permission}`).toBeDefined();
        expect(
          definition?.permittedScopes,
          `${role} holds ${grant.permission} at ${grant.scope}, which that permission does not permit`,
        ).toContain(grant.scope);
      }
    }
  });

  it("grants each permission to a role at most once", () => {
    for (const role of ROLES) {
      const keys = ROLE_GRANTS[role].map((grant) => grant.permission);
      expect(new Set(keys).size, `${role} grants a permission twice`).toBe(keys.length);
    }
  });

  it("gives every role the reference-data read, so no screen loads without its vocabulary", () => {
    for (const role of ROLES) {
      expect(hasPermission([role], "master_data.read", "all")).toBe(true);
    }
  });
});

describe("the shape of each role", () => {
  it("keeps the telecaller's cases own while people stay all — recognition is the product (Principle #4)", () => {
    expect(hasPermission(["telecaller"], "case.read", "all")).toBe(false);
    expect(hasPermission(["telecaller"], "case.read", "own")).toBe(true);
    expect(hasPermission(["telecaller"], "person.read", "all")).toBe(true);
  });

  it("withholds verification, waiver and sensitive data from the telecaller", () => {
    for (const withheld of [
      "document.verify",
      "requirement.waive",
      "identifier.view_full",
      "commercial.view",
      "event.view",
    ]) {
      expect(hasPermission(["telecaller"], withheld, "own")).toBe(false);
    }
  });

  it("gives the login desk every file, because it works whatever is in front of it", () => {
    for (const key of ["case.read", "case.update", "document.read", "document.verify"]) {
      expect(hasPermission(["login_executive"], key, "all")).toBe(true);
    }
  });

  it("does not let the manager close a case — closing asserts the invoice is raised", () => {
    expect(hasPermission(["manager"], "case.close", "own")).toBe(false);
    expect(hasPermission(["finance"], "case.close", "all")).toBe(true);
  });

  it("withholds commercial.view from the manager, pending the business answer", () => {
    expect(hasPermission(["manager"], "commercial.view", "all")).toBe(false);
    expect(hasPermission(["finance"], "commercial.view", "all")).toBe(true);
  });

  it("keeps finance narrow: money and the names it needs to invoice, nothing else", () => {
    expect(hasPermission(["finance"], "person.read", "all")).toBe(true);
    expect(hasPermission(["finance"], "case.update", "own")).toBe(false);
    expect(hasPermission(["finance"], "document.verify", "own")).toBe(false);
    expect(hasPermission(["finance"], "document.read", "own")).toBe(false);
  });

  it("denies admin the customers' content: administering is not a licence to read", () => {
    for (const withheld of [
      "identifier.view_full",
      "commercial.view",
      "document.read",
      "communication.read",
      "note.read",
      "case.update",
      "document.verify",
    ]) {
      expect(
        hasPermission(["admin"], withheld, "own"),
        `admin should not hold ${withheld}`,
      ).toBe(false);
    }
  });

  it("gives admin the structure it needs to answer 'why can this user not see that case?'", () => {
    for (const key of ["case.read", "person.read", "event.view", "user.read"]) {
      expect(hasPermission(["admin"], key, "all")).toBe(true);
    }
  });
});

describe("holding several roles", () => {
  const both: readonly Role[] = ["telecaller", "login_executive"];

  it("gives the union, at the widest scope any role grants (BR-061)", () => {
    expect(hasPermission(both, "case.read", "all")).toBe(true);
    expect(effectivePermissions(both).get("case.read")).toBe("all");
  });

  it("never narrows a permission by adding a role", () => {
    for (const role of ROLES) {
      const alone = effectivePermissions([role]);
      const combined = effectivePermissions([role, "telecaller"]);
      for (const [key, scope] of alone) {
        const widened = combined.get(key);
        expect(widened, `${key} vanished when a second role was added`).toBeDefined();
        expect(scopeSatisfies(widened as never, scope)).toBe(true);
      }
    }
  });

  it("refuses an unknown permission rather than throwing", () => {
    expect(hasPermission(["admin"], "case.destroy", "all")).toBe(false);
  });
});
