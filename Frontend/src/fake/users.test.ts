import { describe, expect, it, vi } from "vitest";

import { createStorageModule } from "./storage.mock.js";

/**
 * User administration and data isolation (Employee Authentication milestone).
 *
 * WHAT THESE TESTS ARE FOR
 *
 * The milestone's non-negotiable rule is that authorization is enforced by
 * the domain/store layer, not by hiding buttons. These tests call the store
 * functions directly — the same functions every screen calls — and check
 * that a telecaller genuinely cannot do a manager's job, that a deactivated
 * user genuinely loses access (not just the ability to log in), and that
 * permission overrides resolve deterministically through the real
 * `authorize()` guard, not a parallel check.
 */

function installLocalStoragePolyfill(): void {
  const backing = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => (backing.has(key) ? (backing.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
    clear: () => backing.clear(),
    key: () => null,
    get length() {
      return backing.size;
    },
  } as Storage;
}

installLocalStoragePolyfill();

vi.doMock("./storage.js", () => createStorageModule());

const {
  canActOnCase,
  createCase,
  createUser,
  deleteUser,
  findUserByUsername,
  getDb,
  resetDatabase,
  resetUserPassword,
  revokePermissionOverride,
  setPermissionOverride,
  setUserActive,
  setUserRoles,
  verifyDocument,
} = await import("./store.js");

function managerId(): string {
  const id = getDb().users.find((u) => u.roles.includes("manager"))?.id;
  if (!id) throw new Error("test setup: expected a seeded manager");
  return id;
}

function telecallerOnlyId(): string {
  const id = getDb().users.find((u) => u.roles.length === 1 && u.roles[0] === "telecaller")?.id;
  if (!id) throw new Error("test setup: expected a seeded telecaller-only user");
  return id;
}

function loginExecutiveId(): string {
  const id = getDb().users.find((u) => u.roles.includes("login_executive"))?.id;
  if (!id) throw new Error("test setup: expected a seeded login executive");
  return id;
}

function firstProductId(): string {
  const id = getDb().loanProducts[0]?.id;
  if (!id) throw new Error("test setup: expected a seeded loan product");
  return id;
}

/** A requirement with a document uploaded against it but not yet verified — what `verifyDocument` needs. */
function unverifiedRequirementId(): string {
  const id = getDb().requirements.find(
    (r) => r.satisfiedByDocumentId && r.status === "received",
  )?.id;
  if (!id) throw new Error("test setup: expected a seeded received-but-unverified requirement");
  return id;
}

describe("createUser", () => {
  it("lets a manager create a new employee account", () => {
    resetDatabase();
    const result = createUser(
      { name: "Test Employee", username: "test.employee", passwordHash: "hash", roles: ["telecaller"] },
      managerId(),
    );
    expect(result.ok).toBe(true);
    expect(findUserByUsername("test.employee")?.name).toBe("Test Employee");
  });

  it("refuses a telecaller — user.manage is not held", () => {
    resetDatabase();
    const result = createUser(
      { name: "Test Employee", username: "nope", passwordHash: "hash", roles: ["telecaller"] },
      telecallerOnlyId(),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a duplicate username", () => {
    resetDatabase();
    const first = createUser(
      { name: "First", username: "dup.user", passwordHash: "hash", roles: ["telecaller"] },
      managerId(),
    );
    expect(first.ok).toBe(true);
    const second = createUser(
      { name: "Second", username: "dup.user", passwordHash: "hash", roles: ["telecaller"] },
      managerId(),
    );
    expect(second.ok).toBe(false);
  });

  it("refuses an account with no roles", () => {
    resetDatabase();
    const result = createUser(
      { name: "No Roles", username: "no.roles", passwordHash: "hash", roles: [] },
      managerId(),
    );
    expect(result.ok).toBe(false);
  });
});

describe("setUserRoles", () => {
  it("lets a manager assign roles", () => {
    resetDatabase();
    const created = createUser(
      { name: "Role Target", username: "role.target", passwordHash: "hash", roles: ["telecaller"] },
      managerId(),
    );
    expect(created.ok).toBe(true);
    const user = findUserByUsername("role.target");
    if (!user) throw new Error("expected the user just created");

    const result = setUserRoles(user.id, ["telecaller", "login_executive"], managerId());
    expect(result.ok).toBe(true);
    expect(findUserByUsername("role.target")?.roles).toEqual(["telecaller", "login_executive"]);
  });

  it("refuses a telecaller assigning roles, even to themselves", () => {
    resetDatabase();
    const self = telecallerOnlyId();
    const result = setUserRoles(self, ["manager"], self);
    expect(result.ok).toBe(false);
  });
});

describe("setUserActive — deactivation removes access, not just login", () => {
  it("a deactivated user holds no permissions for new actions", () => {
    resetDatabase();
    const target = telecallerOnlyId();
    const manager = managerId();
    const product = getDb().loanProducts[0]?.id;
    if (!product) throw new Error("expected a seeded loan product");

    const deactivated = setUserActive(target, false, manager);
    expect(deactivated.ok).toBe(true);

    // case.create is granted to telecaller at "all" — but this actor is now
    // inactive, so actorRoles() must return no roles and authorize() must
    // refuse, exactly as it would for someone holding no roles at all.
    expect(() =>
      createCase({ newApplicantName: "Should Not Be Created", loanProductId: product }, target),
    ).toThrow();
    const db = getDb();
    expect(db.cases.some((c) => c.createdByUserId === target)).toBe(false);
  });

  it("reactivating restores access", () => {
    resetDatabase();
    const target = telecallerOnlyId();
    const manager = managerId();
    setUserActive(target, false, manager);
    const reactivated = setUserActive(target, true, manager);
    expect(reactivated.ok).toBe(true);

    const caseId = createCase(
      { newApplicantName: "Reactivated Works", loanProductId: firstProductId() },
      target,
    );
    expect(getDb().cases.some((c) => c.id === caseId)).toBe(true);
  });

  it("refuses letting a manager deactivate their own account", () => {
    resetDatabase();
    const manager = managerId();
    const result = setUserActive(manager, false, manager);
    expect(result.ok).toBe(false);
  });
});

describe("deleteUser", () => {
  it("refuses to delete a user with case history — deactivate instead", () => {
    resetDatabase();
    const manager = managerId();
    const telecaller = telecallerOnlyId();
    createCase({ newApplicantName: "Historical Case", loanProductId: firstProductId() }, telecaller);

    const result = deleteUser(telecaller, manager);
    expect(result.ok).toBe(false);
    expect(getDb().users.some((u) => u.id === telecaller)).toBe(true);
  });

  it("deletes a user with no historical references at all", () => {
    resetDatabase();
    const manager = managerId();
    createUser(
      { name: "Fresh Account", username: "fresh.account", passwordHash: "hash", roles: ["telecaller"] },
      manager,
    );
    const fresh = findUserByUsername("fresh.account");
    if (!fresh) throw new Error("expected the freshly created user");

    const result = deleteUser(fresh.id, manager);
    expect(result.ok).toBe(true);
    expect(getDb().users.some((u) => u.id === fresh.id)).toBe(false);
  });

  it("refuses self-deletion", () => {
    resetDatabase();
    const manager = managerId();
    expect(deleteUser(manager, manager).ok).toBe(false);
  });
});

describe("resetUserPassword", () => {
  it("lets a manager set a new password hash", () => {
    resetDatabase();
    const target = telecallerOnlyId();
    const before = findUserByUsername(getDb().users.find((u) => u.id === target)?.username ?? "");
    const result = resetUserPassword(target, "new-hash-value", managerId());
    expect(result.ok).toBe(true);
    const after = getDb().users.find((u) => u.id === target);
    expect(after?.passwordHash).toBe("new-hash-value");
    expect(after?.passwordHash).not.toBe(before?.passwordHash);
  });
});

describe("permission overrides through the real authorize() guard", () => {
  it("a deny override blocks an action a role would otherwise allow", () => {
    resetDatabase();
    const manager = managerId();
    const loginExecutive = loginExecutiveId();

    setPermissionOverride(loginExecutive, "document.verify", "all", "deny", manager);

    const result = verifyDocument(unverifiedRequirementId(), loginExecutive);
    expect(result.ok).toBe(false);
  });

  it("revoking a deny override restores the role-derived permission", () => {
    resetDatabase();
    const manager = managerId();
    const loginExecutive = loginExecutiveId();

    const set = setPermissionOverride(loginExecutive, "document.verify", "all", "deny", manager);
    expect(set.ok).toBe(true);
    const overrideId = getDb().users.find((u) => u.id === loginExecutive)?.permissionOverrides?.[0]?.id;
    if (!overrideId) throw new Error("expected the override just created");

    const revoked = revokePermissionOverride(loginExecutive, overrideId, manager);
    expect(revoked.ok).toBe(true);

    const result = verifyDocument(unverifiedRequirementId(), loginExecutive);
    expect(result.ok).toBe(true);
  });

  it("only a holder of permission.override may set an override", () => {
    resetDatabase();
    const telecaller = telecallerOnlyId();
    const loginExecutive = loginExecutiveId();
    const result = setPermissionOverride(loginExecutive, "document.verify", "all", "deny", telecaller);
    expect(result.ok).toBe(false);
  });
});

describe("case data isolation — canActOnCase", () => {
  it("a telecaller may act on their own case but not a colleague's", () => {
    resetDatabase();
    const telecaller = telecallerOnlyId();
    const manager = managerId();
    const product = firstProductId();

    const ownCaseId = createCase({ newApplicantName: "Own Case", loanProductId: product }, telecaller);
    const otherCaseId = createCase({ newApplicantName: "Manager's Case", loanProductId: product }, manager);

    const ownCase = getDb().cases.find((c) => c.id === ownCaseId);
    const otherCase = getDb().cases.find((c) => c.id === otherCaseId);
    if (!ownCase || !otherCase) throw new Error("expected both cases to exist");

    expect(canActOnCase(telecaller, ownCase, "case.read")).toBe(true);
    expect(canActOnCase(telecaller, otherCase, "case.read")).toBe(false);
  });

  it("a login executive may act on any case (case.read at all)", () => {
    resetDatabase();
    const telecaller = telecallerOnlyId();
    const loginExecutive = loginExecutiveId();
    const caseId = createCase(
      { newApplicantName: "Telecaller's Case", loanProductId: firstProductId() },
      telecaller,
    );
    const loanCase = getDb().cases.find((c) => c.id === caseId);
    if (!loanCase) throw new Error("expected the case to exist");

    expect(canActOnCase(loginExecutive, loanCase, "case.read")).toBe(true);
  });
});

describe("findUserByUsername", () => {
  it("matches case-insensitively", () => {
    resetDatabase();
    const seeded = getDb().users[0];
    if (!seeded) throw new Error("expected a seeded user");
    expect(findUserByUsername(seeded.username.toUpperCase())?.id).toBe(seeded.id);
  });

  it("returns undefined for an unknown username", () => {
    resetDatabase();
    expect(findUserByUsername("does-not-exist")).toBeUndefined();
  });
});
