import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./password.js";

describe("hashPassword / verifyPassword", () => {
  it("verifies the correct password against its own hash", async () => {
    const hash = await hashPassword("Amaze@123");
    expect(await verifyPassword("Amaze@123", hash)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("Amaze@123");
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("never stores the plaintext password in the hash output", async () => {
    const hash = await hashPassword("Amaze@123");
    expect(hash).not.toContain("Amaze@123");
  });

  it("produces a different hash each time for the same password (random salt)", async () => {
    const first = await hashPassword("Amaze@123");
    const second = await hashPassword("Amaze@123");
    expect(first).not.toBe(second);
    expect(await verifyPassword("Amaze@123", first)).toBe(true);
    expect(await verifyPassword("Amaze@123", second)).toBe(true);
  });

  it("fails closed on a malformed stored hash instead of throwing", async () => {
    await expect(verifyPassword("anything", "not-a-real-hash")).resolves.toBe(false);
    await expect(verifyPassword("anything", "pbkdf2$abc$zz$zz")).resolves.toBe(false);
    await expect(verifyPassword("anything", "")).resolves.toBe(false);
  });

  it("fails closed on a tampered hash portion", async () => {
    const hash = await hashPassword("Amaze@123");
    const parts = hash.split("$");
    const hashPart = parts[3] ?? "";
    parts[3] = hashPart.slice(0, -2) + (hashPart.slice(-2) === "00" ? "ff" : "00");
    expect(await verifyPassword("Amaze@123", parts.join("$"))).toBe(false);
  });

  it("handles an empty password without throwing", async () => {
    const hash = await hashPassword("");
    expect(await verifyPassword("", hash)).toBe(true);
    expect(await verifyPassword("not-empty", hash)).toBe(false);
  });
});
