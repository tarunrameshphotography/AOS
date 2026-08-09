/**
 * Load `.env` from the repository root, if there is one.
 *
 * This is the loader `mail-server.mjs` introduced, lifted into a module now
 * that a third backend process needs it. The reasoning is unchanged and worth
 * keeping: fifteen lines rather than `dotenv`, and rather than
 * `node --env-file`, because that flag fails outright when the file is absent
 * and an office install that has not been configured yet should start and say
 * so, not crash.
 *
 * A variable already present in the real environment always wins, so
 * `AOS_DB_NAME=aos_test npm run migrate` overrides the file — which is how the
 * integration tests point at a throwaway database instead of the office one.
 *
 * `mail-server.mjs` keeps its own copy for now: it works, it is covered by the
 * mail tests, and rewiring a running backend is not part of this milestone.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadDotEnv() {
  try {
    const raw = readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match || line.trimStart().startsWith("#")) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.trim().replace(/^["'](.*)["']$/, "$1");
    }
  } catch {
    // No .env — every caller falls back to its documented default.
  }
}
