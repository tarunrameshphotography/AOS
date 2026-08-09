/**
 * One-way password hashing.
 *
 * Source of truth: Employee Authentication milestone.
 *
 * PBKDF2-SHA256 with a random per-password salt, via the Web Crypto API —
 * built into both the browser and Node ≥20 as a global (`crypto.subtle`), so
 * this needs no new dependency and runs identically in the fake store today
 * and in a real backend later. A plaintext password is never stored; only the
 * string this module produces is, and it is opaque without the corresponding
 * `verifyPassword` call.
 *
 * The encoded form is `pbkdf2$<iterations>$<salt-hex>$<hash-hex>` — the
 * iteration count travels with the hash so it can be raised later without
 * invalidating passwords hashed under a lower count.
 */

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;
const ALGORITHM_TAG = "pbkdf2";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function deriveHash(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    // Web Crypto's `salt` type differs between Node's ambient types (the
    // root tsconfig, no DOM lib) and the DOM lib types (Frontend's
    // tsconfig) — a real disagreement between two valid typings of the same
    // runtime API, not a bug here. `as any` sidesteps it without depending
    // on a type name only one of the two configs has.
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" } as any,
    keyMaterial,
    HASH_BITS,
  );
  return new Uint8Array(derived);
}

/** Hash a password for storage. Never throws on empty input — an empty password just hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveHash(password, salt, PBKDF2_ITERATIONS);
  return `${ALGORITHM_TAG}$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

/**
 * Check a password against a stored hash. Returns `false` — never throws —
 * for a malformed or tampered stored value, so a corrupted record fails
 * closed rather than crashing the login attempt.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== ALGORITHM_TAG) {
    return false;
  }

  const iterations = Number(parts[1]);
  const salt = fromHex(parts[2] ?? "");
  const expected = fromHex(parts[3] ?? "");
  if (!Number.isInteger(iterations) || iterations <= 0 || salt === null || expected === null) {
    return false;
  }

  const actual = await deriveHash(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
