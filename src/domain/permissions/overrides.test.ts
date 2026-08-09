import { describe, expect, it } from "vitest";

import { PERMISSIONS } from "./actions.js";
import { PERMISSION_DISPLAY_NAME } from "./display.js";
import { hasPermission } from "./index.js";
import {
  effectivePermissionsWithOverrides,
  hasPermissionWithOverrides,
  type PermissionOverride,
} from "./overrides.js";

describe("hasPermissionWithOverrides", () => {
  it("matches plain hasPermission when there are no overrides", () => {
    expect(hasPermissionWithOverrides(["telecaller"], [], "case.read", "own")).toBe(
      hasPermission(["telecaller"], "case.read", "own"),
    );
    expect(hasPermissionWithOverrides(["telecaller"], [], "case.read", "all")).toBe(
      hasPermission(["telecaller"], "case.read", "all"),
    );
  });

  it("an explicit grant widens access a role alone would not give", () => {
    expect(hasPermissionWithOverrides(["telecaller"], [], "document.verify", "own")).toBe(false);

    const overrides: PermissionOverride[] = [
      { permission: "document.verify", scope: "all", decision: "grant" },
    ];
    expect(hasPermissionWithOverrides(["telecaller"], overrides, "document.verify", "own")).toBe(
      true,
    );
    expect(hasPermissionWithOverrides(["telecaller"], overrides, "document.verify", "all")).toBe(
      true,
    );
  });

  it("an explicit deny overrides an explicit grant for the same permission", () => {
    const overrides: PermissionOverride[] = [
      { permission: "document.verify", scope: "all", decision: "grant" },
      { permission: "document.verify", scope: "all", decision: "deny" },
    ];
    expect(hasPermissionWithOverrides(["login_executive"], overrides, "document.verify", "own")).toBe(
      false,
    );
  });

  it("an explicit deny blocks a permission the role would otherwise grant, at every scope", () => {
    const overrides: PermissionOverride[] = [
      { permission: "case.read", scope: "all", decision: "deny" },
    ];
    // login_executive normally holds case.read at "all".
    expect(hasPermissionWithOverrides(["login_executive"], [], "case.read", "all")).toBe(true);
    expect(hasPermissionWithOverrides(["login_executive"], overrides, "case.read", "own")).toBe(
      false,
    );
    expect(hasPermissionWithOverrides(["login_executive"], overrides, "case.read", "all")).toBe(
      false,
    );
  });

  it("a grant does not narrow what the role already gives", () => {
    const overrides: PermissionOverride[] = [
      { permission: "case.read", scope: "own", decision: "grant" },
    ];
    // manager already holds case.read at "all"; a narrower grant must not shrink it.
    expect(hasPermissionWithOverrides(["manager"], overrides, "case.read", "all")).toBe(true);
  });

  it("returns false for an unknown permission regardless of overrides", () => {
    const overrides: PermissionOverride[] = [
      { permission: "not.a.real.permission", scope: "all", decision: "grant" },
    ];
    expect(hasPermissionWithOverrides(["manager"], overrides, "not.a.real.permission")).toBe(false);
  });

  it("is deterministic: same roles and overrides always produce the same answer", () => {
    const overrides: PermissionOverride[] = [
      { permission: "case.read", scope: "all", decision: "grant" },
      { permission: "document.verify", scope: "all", decision: "deny" },
    ];
    const first = hasPermissionWithOverrides(["telecaller"], overrides, "case.read", "all");
    const second = hasPermissionWithOverrides(["telecaller"], overrides, "case.read", "all");
    expect(first).toBe(second);
    expect(first).toBe(true);
  });
});

describe("effectivePermissionsWithOverrides", () => {
  it("reports role-derived permissions as kind 'role'", () => {
    const effective = effectivePermissionsWithOverrides(["telecaller"], []);
    expect(effective.get("case.read")).toEqual({ kind: "role", scope: "own" });
  });

  it("reports a grant override distinctly from a role-derived permission", () => {
    const overrides: PermissionOverride[] = [
      { permission: "case.read", scope: "all", decision: "grant" },
    ];
    const effective = effectivePermissionsWithOverrides(["telecaller"], overrides);
    expect(effective.get("case.read")).toEqual({
      kind: "override_grant",
      scope: "all",
      roleScope: "own",
    });
  });

  it("reports a deny override distinctly, keeping the role scope it overrides visible", () => {
    const overrides: PermissionOverride[] = [
      { permission: "document.verify", scope: "all", decision: "deny" },
    ];
    const effective = effectivePermissionsWithOverrides(["login_executive"], overrides);
    expect(effective.get("document.verify")).toEqual({
      kind: "override_deny",
      roleScope: "all",
    });
  });

  it("reports 'none' for a permission held by neither role nor override", () => {
    const effective = effectivePermissionsWithOverrides(["telecaller"], []);
    expect(effective.get("case.close")).toEqual({ kind: "none" });
  });

  it("covers every permission in the catalog", () => {
    const effective = effectivePermissionsWithOverrides(["telecaller"], []);
    for (const permission of PERMISSIONS) {
      expect(effective.has(permission.key)).toBe(true);
    }
  });
});

describe("PERMISSION_DISPLAY_NAME", () => {
  it("has a friendly label for every permission in the catalog", () => {
    for (const permission of PERMISSIONS) {
      expect(PERMISSION_DISPLAY_NAME[permission.key], `missing label for ${permission.key}`).toBeTruthy();
    }
  });

  it("never exposes the raw dotted key as the label itself", () => {
    for (const permission of PERMISSIONS) {
      expect(PERMISSION_DISPLAY_NAME[permission.key]).not.toBe(permission.key);
    }
  });
});
