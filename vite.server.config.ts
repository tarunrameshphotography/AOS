import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * Config for the backend processes, which run under `vite-node`.
 *
 * WHY vite-node RATHER THAN PLAIN NODE: the API server's whole point is to
 * reuse `src/domain/` — the permission catalog, the scope rules, the password
 * hashing — rather than reimplementing them server-side, which is precisely
 * the drift ADR-022 forbids. Those modules are TypeScript using `.js`
 * specifiers under `moduleResolution: bundler`, which Node cannot resolve on
 * its own. vite-node applies the same resolution the app and the test suite
 * already use, so the backend imports the identical files with no build step,
 * no generated output, and no new dependency — vite-node ships with vitest,
 * which is already here.
 *
 * The main `vite.config.ts` roots itself at `Frontend/` and loads React and
 * Tailwind. None of that applies to a Node process, hence a second, smaller
 * config rather than a conditional in the first.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@domain": fileURLToPath(new URL("./src/domain", import.meta.url)),
    },
  },
});
