/**
 * Locating and running the PostgreSQL command-line tools.
 *
 * Lifted out of `backup.mjs` and `restore.mjs`, which had grown identical
 * copies of `resolvePgBinDir()` and `run()`. A third caller
 * (`backup-verify.mjs`, which needs `pg_restore` to read an archive's table of
 * contents) made the duplication worth removing: the day PostgreSQL 18 is
 * installed, the search path should change in one place, not three.
 *
 * The search order is unchanged and deliberately short — an explicit env var,
 * then the one location the Windows installer uses. Nothing is guessed past
 * that: an unresolved binary is a loud failure, never a silently wrong one.
 */

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

/** Versions to look for under `C:\Program Files\PostgreSQL`, newest first. */
const KNOWN_VERSIONS = ["18", "17", "16", "15"];

export function resolvePgBinDir() {
  if (process.env.AOS_PG_BIN_DIR?.trim()) return process.env.AOS_PG_BIN_DIR.trim();
  for (const version of KNOWN_VERSIONS) {
    const candidate = `C:\\Program Files\\PostgreSQL\\${version}\\bin`;
    if (existsSync(path.join(candidate, "pg_dump.exe"))) return candidate;
  }
  return null;
}

/**
 * The bin directory or a clear instruction, never a guess.
 *
 * `label` names the binary the caller actually wants, so the message says
 * "Could not find pg_restore" to someone running a restore rather than
 * mentioning pg_dump, which they never typed.
 */
export function requirePgBinDir(label = "pg_dump") {
  const binDir = resolvePgBinDir();
  if (binDir) return binDir;
  console.error(
    `\n  Could not find ${label}. Set AOS_PG_BIN_DIR to the PostgreSQL 'bin' folder\n` +
      `  (e.g. C:\\Program Files\\PostgreSQL\\17\\bin) and try again.\n`,
  );
  process.exit(1);
}

/** Run a command to completion, inheriting stdio. Rejects on a non-zero exit. */
export function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with code ${code}`));
    });
  });
}

/**
 * Run a command and capture stdout instead of inheriting it.
 *
 * `pg_restore --list` is read for its output, not its side effects — the
 * archive's table of contents is how `backup-verify.mjs` establishes that a
 * dump is readable and non-empty without restoring it anywhere.
 */
export function runCapturing(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(command)} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
