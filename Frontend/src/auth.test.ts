import { describe, expect, it, vi } from "vitest";

import { hashPassword } from "@domain/auth/password.js";

import { createStorageModule } from "./fake/storage.mock.js";

/**
 * Login outcomes (Employee Authentication milestone).
 *
 * WHAT THESE TESTS ARE FOR
 *
 * `attemptLogin` is the one function standing between a typed username/
 * password and a real session. These tests cover the four outcomes the
 * milestone calls out explicitly: a valid login succeeds, a wrong password is
 * rejected, an unknown username is rejected, and a deactivated user cannot
 * log in even with the right password.
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

vi.doMock("./fake/storage.js", () => createStorageModule());

const { attemptLogin } = await import("./auth.js");
const { createUser, getDb, resetDatabase, setUserActive } = await import("./fake/store.js");

function managerId(): string {
  const id = getDb().users.find((u) => u.roles.includes("manager"))?.id;
  if (!id) throw new Error("test setup: expected a seeded manager");
  return id;
}

async function seedTestEmployee(password: string): Promise<{ userId: string; username: string }> {
  resetDatabase();
  const passwordHash = await hashPassword(password);
  const username = "login.test.user";
  const result = createUser(
    { name: "Login Test User", username, passwordHash, roles: ["telecaller"] },
    managerId(),
  );
  if (!result.ok) throw new Error(`test setup: createUser failed: ${result.message}`);
  const user = getDb().users.find((u) => u.username === username);
  if (!user) throw new Error("test setup: expected the user just created");
  return { userId: user.id, username };
}

describe("attemptLogin", () => {
  it("succeeds for a valid username and password", async () => {
    const { userId, username } = await seedTestEmployee("Correct-Horse-1");
    const result = await attemptLogin(username, "Correct-Horse-1");
    expect(result).toEqual({ ok: true, userId });
  });

  it("rejects the wrong password", async () => {
    const { username } = await seedTestEmployee("Correct-Horse-1");
    const result = await attemptLogin(username, "wrong-password");
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown username", async () => {
    await seedTestEmployee("Correct-Horse-1");
    const result = await attemptLogin("nobody-by-this-name", "anything");
    expect(result.ok).toBe(false);
  });

  it("gives the same generic message for an unknown username and a wrong password", async () => {
    const { username } = await seedTestEmployee("Correct-Horse-1");
    const unknown = await attemptLogin("nobody-by-this-name", "anything");
    const wrongPassword = await attemptLogin(username, "wrong-password");
    expect(unknown.ok).toBe(false);
    expect(wrongPassword.ok).toBe(false);
    if (unknown.ok || wrongPassword.ok) throw new Error("unreachable");
    expect(unknown.message).toBe(wrongPassword.message);
  });

  it("rejects a deactivated user even with the correct password", async () => {
    const { userId, username } = await seedTestEmployee("Correct-Horse-1");
    setUserActive(userId, false, managerId());
    const result = await attemptLogin(username, "Correct-Horse-1");
    expect(result.ok).toBe(false);
  });

  it("matches the username case-insensitively", async () => {
    const { userId, username } = await seedTestEmployee("Correct-Horse-1");
    const result = await attemptLogin(username.toUpperCase(), "Correct-Horse-1");
    expect(result).toEqual({ ok: true, userId });
  });

  it("records a login event on success", async () => {
    const { userId, username } = await seedTestEmployee("Correct-Horse-1");
    await attemptLogin(username, "Correct-Horse-1");
    const loggedIn = getDb().events.some(
      (e) => e.actorUserId === userId && e.eventType === "user.logged_in",
    );
    expect(loggedIn).toBe(true);
  });
});
