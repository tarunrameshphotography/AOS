import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `client.ts` reads sessionStorage (the token) and touches localStorage (a
 * one-time cleanup of a pre-migration key) — neither exists in Vitest's
 * default node environment. Minimal in-memory polyfills, installed before the
 * module is imported, same approach as `Frontend/src/fake/store.test.ts`.
 */
function installStoragePolyfill(name: "sessionStorage" | "localStorage"): void {
  const backing = new Map<string, string>();
  (globalThis as unknown as Record<string, Storage>)[name] = {
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

installStoragePolyfill("sessionStorage");
installStoragePolyfill("localStorage");

const { api, getLastActivityAt, onActivity, storeToken } = await import("./client.js");

function mockFetchOnce(status: number, body: unknown = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    }),
  );
}

/**
 * The idle-timeout warning (`Frontend/src/auth/IdleSessionMonitor.tsx`) reads
 * `getLastActivityAt()` to decide when to fire — these tests are the
 * contract it depends on: which requests move that clock, and which do not.
 * The rule mirrors the server's (Backend/api-server.ts's `loadActor`, which
 * touches `last_seen_at` for any request that resolves to a valid session,
 * whatever the route then decides).
 */
describe("api() activity tracking — feeds the idle-session clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    storeToken(null);
  });

  afterEach(() => {
    storeToken(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not count a request made with no stored token", async () => {
    mockFetchOnce(200);
    const before = getLastActivityAt();
    vi.setSystemTime(1_500_000);
    await api("/health");
    expect(getLastActivityAt()).toBe(before);
  });

  it("counts a successful authenticated request", async () => {
    storeToken("a-real-token");
    mockFetchOnce(200);
    vi.setSystemTime(2_000_000);
    await api("/cases");
    expect(getLastActivityAt()).toBe(2_000_000);
  });

  it("does not count an anonymous request, even with a token already stored", async () => {
    storeToken("a-real-token");
    mockFetchOnce(200);
    const before = getLastActivityAt();
    vi.setSystemTime(2_000_000);
    await api("/auth/login", { method: "POST", body: {}, anonymous: true });
    expect(getLastActivityAt()).toBe(before);
  });

  it("does not count a 401 — the token was already no good, not fresh activity", async () => {
    storeToken("a-real-token");
    mockFetchOnce(401);
    const before = getLastActivityAt();
    vi.setSystemTime(3_000_000);
    await expect(api("/cases")).rejects.toThrow();
    expect(getLastActivityAt()).toBe(before);
  });

  it("counts a request refused for another reason (403) — the session itself was valid", async () => {
    storeToken("a-real-token");
    mockFetchOnce(403, { message: "no" });
    vi.setSystemTime(4_000_000);
    await expect(api("/cases")).rejects.toThrow();
    expect(getLastActivityAt()).toBe(4_000_000);
  });

  it("notifies onActivity subscribers exactly when activity is counted", async () => {
    storeToken("a-real-token");
    mockFetchOnce(200);
    const seen: number[] = [];
    const unsubscribe = onActivity((at) => seen.push(at));
    vi.setSystemTime(5_000_000);
    await api("/cases");
    unsubscribe();
    expect(seen).toEqual([5_000_000]);
  });
});
