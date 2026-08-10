import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Integration tests — real PostgreSQL, real HTTP, real permission checks.
 *
 * Separate from `vitest.config.ts` on purpose. The unit suite runs anywhere
 * with no services; these need a database. Merging them would mean `npm test`
 * failing on a laptop with no Postgres, which trains people to ignore a red
 * suite — the worst outcome available.
 *
 * `AOS_DB_NAME` is set here rather than in `.env` so the suite physically
 * cannot address the office database: `loadDotEnv` never overwrites a variable
 * that is already set.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ["Backend/**/*.test.ts"],
    globalSetup: ["Backend/test-globalsetup.ts"],
    env: {
      AOS_DB_NAME: "aos_test",
      // api-server.ts listens on import when started as a process; the tests
      // want to bind their own ephemeral port instead.
      AOS_API_NO_LISTEN: "1",
      // A dedicated port, never the office storage backend's 4319 — a suite
      // that could accidentally write real document bytes to the office disk
      // is exactly the class of mistake `AOS_REQUIRE_DB_NAME` (db.ts) exists
      // to prevent for Postgres. Backend/documents.test.ts spawns its own
      // storage-server instance on this port, rooted in a throwaway temp
      // directory.
      AOS_STORAGE_SERVER_URL: "http://127.0.0.1:4329",
      // Same reasoning, for mail: a dedicated port and the `capture` provider,
      // never the office Gmail mailbox on 4320. Backend/submissions.test.ts
      // spawns its own mail-server instance on this port.
      AOS_MAIL_SERVER_URL: "http://127.0.0.1:4330",
    },
    // One database, shared state. Parallel files would race on the case-number
    // sequence and on each other's fixtures.
    fileParallelism: false,
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@domain": fileURLToPath(new URL("./src/domain", import.meta.url)),
    },
  },
});
