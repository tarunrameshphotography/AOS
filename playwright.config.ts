import { defineConfig, devices } from "@playwright/test";

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
 *
 * NOTE: `reuseExistingServer` is true, so a dev server already running without
 * these variables is used as-is and the mail tests will fail on an
 * unconfigured provider. Stop it first, or run the suite on a clean machine.
 */
const MAIL_CAPTURE_DIR = process.env.AOS_MAIL_CAPTURE_DIR ?? "C:/AOS/QA-Mail";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 60_000,
    env: {
      AOS_STORAGE_ROOT: STORAGE_ROOT,
      AOS_MAIL_PROVIDER: "capture",
      AOS_MAIL_CAPTURE_DIR: MAIL_CAPTURE_DIR,
    },
  },
});
