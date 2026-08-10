import { defineConfig, devices } from "@playwright/test";

import { E2E_API_PORT, E2E_DB, E2E_VITE_PORT } from "./tests/support/e2e-environment";

const STORAGE_ROOT = process.env.AOS_STORAGE_ROOT ?? "C:/AOS/QA-Data";

/**
 * The suite runs the mail backend in `capture` mode: messages are built the
 * same way a real send builds them and written to disk instead of leaving the
 * machine. Nothing here can mail a real bank, and nothing here needs a
 * credential.
 *
 * Real Gmail delivery is deliberately NOT exercised by any automated test. It
 * needs a live credential, it is not deterministic, and a green suite that
 * depends on Google being up is a suite that lies about what it proved. See
 * Docs/Email and WhatsApp Integration.md for the manual check that covers it.
 */
const MAIL_CAPTURE_DIR = process.env.AOS_MAIL_CAPTURE_DIR ?? "C:/AOS/QA-Mail";

/**
 * ============================================================================
 * THE SUITE OWNS ITS OWN STACK. IT NEVER BORROWS THE OFFICE ONE.
 * ============================================================================
 *
 * This is the correction Stage 3C-0 exists partly to make. The previous
 * configuration set `AOS_DB_NAME: "aos_e2e"` on the server it started, and
 * `reuseExistingServer: true` — so if a developer had `npm run dev` already
 * running (which, in an office where this is the app people work in, is most
 * of the time), Playwright quietly adopted THAT server instead. That server is
 * connected to `aos`. The suite creates customers, opens cases, and — as of
 * this stage — creates employees, resets passwords and deactivates accounts.
 * All of it would have landed in the live office database, and nothing would
 * have said so.
 *
 * Four independent things now have to fail before that can happen again:
 *
 *   1. `reuseExistingServer: false`. Playwright starts the stack itself, every
 *      run, and shuts it down after.
 *   2. Its own ports (5174/4322). The office stack on 5173/4321 is not on the
 *      suite's path at all, in either direction.
 *   3. `strictPort` in vite.config.ts. A port already in use is an error, not
 *      a silent shift onto a neighbour's server.
 *   4. `AOS_REQUIRE_DB_NAME`. The API process refuses to start against any
 *      database but `aos_e2e` (Backend/db.ts), whatever else is set.
 *
 * It also runs `dev:e2e` rather than `dev`: vite and the API only. The storage
 * and mail backends belong to the document and submission features, which have
 * not migrated and whose specs are skipped — starting them here would collide
 * with the office copies for no benefit.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/support/e2e-globalsetup.ts",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: `http://localhost:${E2E_VITE_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev:e2e",
    url: `http://localhost:${E2E_VITE_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      AOS_STORAGE_ROOT: STORAGE_ROOT,
      AOS_MAIL_PROVIDER: "capture",
      AOS_MAIL_CAPTURE_DIR: MAIL_CAPTURE_DIR,
      AOS_VITE_PORT: String(E2E_VITE_PORT),
      AOS_API_PORT: String(E2E_API_PORT),
      AOS_DB_NAME: E2E_DB,
      // The belt to the above braces: the API process aborts at startup if
      // this and AOS_DB_NAME ever disagree.
      AOS_REQUIRE_DB_NAME: E2E_DB,
    },
  },
});
