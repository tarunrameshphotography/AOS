/**
 * Login — checking a username/password against the fake store's seeded
 * employees (Employee Authentication milestone).
 *
 * Deliberately thin: `findUserByUsername`/`recordLogin` live in `fake/store.ts`
 * next to every other store operation, and the actual hashing/verification is
 * `src/domain/auth/password.ts`. This module just wires the three together
 * and picks one generic failure message for "no such user" and "wrong
 * password" — telling them apart would let a caller enumerate valid usernames.
 */

import { verifyPassword } from "@domain/auth/password.js";

import { findUserByUsername, recordLogin } from "./fake/store.js";
import type { Id } from "./fake/types.js";

const GENERIC_FAILURE = "Incorrect username or password.";

export type LoginResult = { ok: true; userId: Id } | { ok: false; message: string };

export async function attemptLogin(username: string, password: string): Promise<LoginResult> {
  const user = findUserByUsername(username);
  if (!user || !user.isActive) {
    return { ok: false, message: GENERIC_FAILURE };
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return { ok: false, message: GENERIC_FAILURE };
  }

  recordLogin(user.id);
  return { ok: true, userId: user.id };
}
