#!/usr/bin/env node
/**
 * One process that runs and keeps running the whole AOS backend.
 *
 * WHY (Stage 4 audit, H5). The office had no service lifecycle at all: no
 * auto-start on reboot, no supervision, no restart policy. The only documented
 * way to start AOS was `npm run dev` in a terminal window — a window that gets
 * closed, on a PC that gets rebooted for Windows Update at 3am, after which
 * the office arrives to an application that is simply not there and no
 * indication of why. `Backend/free-dev-ports.mjs` exists precisely because
 * orphaned processes were already a recurring problem.
 *
 * WHAT IT DOES, and deliberately nothing more:
 *
 *   - Starts the four AOS processes in dependency order and waits for each to
 *     answer its health endpoint before starting the next. Starting the API
 *     before PostgreSQL accepts connections is the single most common cause of
 *     a "broken" AOS after a power cut, and it is entirely avoidable.
 *   - Restarts any child that exits, with exponential backoff. A process that
 *     is crash-looping is not helped by being restarted 200 times a second,
 *     and the backoff is what turns "AOS is down" into a log with a pattern
 *     in it.
 *   - Kills the whole tree on shutdown, so Ctrl-C or a service stop does not
 *     leave orphans holding ports 4300/4319/4320/4321 — the exact failure
 *     `free-dev-ports.mjs` was written to clean up after.
 *
 * WHAT IT IS NOT: a process manager. It has no config file, no remote control
 * and no clustering. An office of six PCs running one server does not need
 * PM2, and a dependency that has to be kept up to date is a dependency that
 * will not be.
 *
 * PostgreSQL is NOT started here — it is a Windows service installed by the
 * PostgreSQL installer and starts on its own. The supervisor waits for it.
 *
 * Usage:
 *   npm run start:production      run it in the foreground
 *   Scripts/register-aos-services.ps1   register it to start at boot
 */

import { spawn } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotEnv } from "./env.mjs";
import { freePorts } from "./free-dev-ports.mjs";

loadDotEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const API_PORT = Number(process.env.AOS_API_PORT ?? 4321);
const STORAGE_PORT = Number(process.env.AOS_STORAGE_PORT ?? 4319);
const MAIL_PORT = Number(process.env.AOS_MAIL_PORT ?? 4320);
const WEB_PORT = Number(process.env.AOS_WEB_PORT ?? 4300);

const VITE_NODE = path.join(ROOT, "node_modules", "vite-node", "vite-node.mjs");

/**
 * The four processes, in the order they must come up.
 *
 * Storage and mail first because the API probes them; the API before the web
 * server because the web server proxies to it. Each `health` is checked over
 * loopback regardless of what the process binds publicly — the supervisor is
 * on the same machine by definition.
 */
const SERVICES = [
  {
    name: "storage",
    command: process.execPath,
    args: [path.join(ROOT, "Backend", "storage-server.mjs")],
    health: `http://127.0.0.1:${STORAGE_PORT}/health`,
  },
  {
    name: "mail",
    command: process.execPath,
    args: [path.join(ROOT, "Backend", "mail-server.mjs")],
    health: `http://127.0.0.1:${MAIL_PORT}/health`,
  },
  {
    name: "api",
    // vite-node rather than node: api-server.ts is TypeScript and imports the
    // domain layer through the `@domain` alias, which only vite resolves.
    // Spawned as `node vite-node.mjs` rather than through the .cmd shim in
    // node_modules/.bin, because a shim is a cmd.exe child that swallows the
    // signal on shutdown and leaves the real process orphaned.
    command: process.execPath,
    args: [VITE_NODE, "--config", path.join(ROOT, "vite.server.config.ts"), path.join(ROOT, "Backend", "api-server.ts")],
    health: `http://127.0.0.1:${API_PORT}/api/health`,
  },
  {
    name: "web",
    command: process.execPath,
    args: [path.join(ROOT, "Backend", "web-server.mjs")],
    health: `http://127.0.0.1:${WEB_PORT}/health`,
  },
];

const children = new Map();
let shuttingDown = false;

// ---------------------------------------------------------------------------
// One supervisor at a time
// ---------------------------------------------------------------------------

const LOCK_FILE = path.join(ROOT, "Backend", "supervisor.pid");

/**
 * Refuse to start if another supervisor is already running.
 *
 * FOUND BY RUNNING IT. Two supervisors on one machine do not politely coexist:
 * each sweeps AOS's ports for leftover Node processes at startup, so each
 * kills the OTHER's children, and both then crash-loop on EADDRINUSE while
 * the office sees an application that flickers in and out. It looks exactly
 * like a crash bug and is nothing of the sort.
 *
 * The office scenario is not exotic — it is somebody running
 * `npm run start:production` to "check it works" on a server where the
 * scheduled task already started it at boot.
 *
 * A PID file rather than a lock file: a supervisor that was force-killed
 * leaves the file behind, and a stale PID must not block the next legitimate
 * start. `process.kill(pid, 0)` asks whether that PID still exists without
 * signalling it, which is what distinguishes "already running" from "died
 * badly last time".
 */
function claimSingleInstance() {
  try {
    const previous = Number(readFileSync(LOCK_FILE, "utf8").trim());
    if (Number.isInteger(previous) && previous > 0 && previous !== process.pid) {
      try {
        process.kill(previous, 0);
        console.error(
          `\n  An AOS supervisor is already running on this machine (PID ${previous}).\n\n` +
            `  Two supervisors fight over the same ports and repeatedly kill each\n` +
            `  other's services. Stop the running one first:\n\n` +
            `      Stop-ScheduledTask -TaskName 'AOS Server'\n` +
            `      taskkill /PID ${previous} /T /F\n\n` +
            `  If you are certain nothing is running, delete ${LOCK_FILE}.\n`,
        );
        process.exit(1);
      } catch {
        log("supervis", `clearing a stale lock from PID ${previous} (that process is gone)`);
      }
    }
  } catch {
    // No lock file, or it is unreadable — either way, this is a fresh start.
  }

  writeFileSync(LOCK_FILE, String(process.pid), "utf8");
}

function releaseSingleInstance() {
  try {
    if (Number(readFileSync(LOCK_FILE, "utf8").trim()) === process.pid) unlinkSync(LOCK_FILE);
  } catch {
    // Already gone.
  }
}

function log(service, message) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`${stamp} [${service.padEnd(7)}] ${message}`);
}

/** Wait until `url` answers, or give up. Used both for PostgreSQL's readiness
 * and for each child's own health endpoint. */
async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * Do not start the API until PostgreSQL is accepting connections.
 *
 * On a Windows reboot the PostgreSQL service and this supervisor start at
 * roughly the same moment, and Postgres routinely takes longer. Without this
 * wait the API comes up, fails every request for thirty seconds, and an
 * employee who happened to log in during that window is told AOS is broken.
 */
async function waitForPostgres() {
  const pg = (await import("pg")).default;
  const config = {
    host: process.env.AOS_DB_HOST ?? "127.0.0.1",
    port: Number(process.env.AOS_DB_PORT ?? 5432),
    database: process.env.AOS_DB_NAME ?? "aos",
    user: process.env.AOS_DB_USER ?? "postgres",
    password: process.env.AOS_DB_PASSWORD ?? "",
    connectionTimeoutMillis: 3000,
  };

  const deadline = Date.now() + 120_000;
  let announced = false;
  while (Date.now() < deadline) {
    const client = new pg.Client(config);
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      log("postgres", `reachable at ${config.host}:${config.port}, database "${config.database}"`);
      return true;
    } catch (error) {
      await client.end().catch(() => {});
      if (!announced) {
        log("postgres", `not reachable yet (${error.code ?? error.message}) — waiting up to 2 minutes`);
        announced = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  log("postgres", "STILL NOT REACHABLE after 2 minutes. Starting the rest anyway;");
  log("postgres", "AOS will report a clear database error to employees until it comes back.");
  return false;
}

function start(service) {
  if (shuttingDown) return;

  const child = spawn(service.command, service.args, {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    // A detached child gets its own process group, which is what makes it
    // possible to kill its whole tree on Windows via taskkill /T below.
    windowsHide: true,
  });

  const state = children.get(service.name) ?? { restarts: 0, backoffMs: 1000 };
  state.child = child;
  children.set(service.name, state);

  const relay = (stream) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) log(service.name, line);
    });
  };
  relay(child.stdout);
  relay(child.stderr);

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;

    log(service.name, `exited (${signal ? `signal ${signal}` : `code ${code}`}) — restarting in ${state.backoffMs}ms`);
    state.restarts += 1;

    setTimeout(() => start(service), state.backoffMs);
    // Doubling to a ceiling of 60s: a process that cannot start (a bad .env,
    // a port already taken) then logs roughly once a minute instead of
    // filling the disk, and one that crashed on a transient fault is still
    // back within seconds.
    state.backoffMs = Math.min(state.backoffMs * 2, 60_000);
  });

  child.on("error", (error) => log(service.name, `failed to spawn: ${error.message}`));
}

/**
 * Kill everything, children of children included.
 *
 * `child.kill()` on Windows terminates only the process it names. `vite-node`
 * and `npm` both leave grandchildren holding the listening socket, which is
 * how a "stopped" AOS keeps port 4321 busy and the next start fails with
 * EADDRINUSE. `taskkill /T` walks the tree.
 */
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("supervis", `shutting down (${reason})`);

  for (const [name, state] of children) {
    const child = state.child;
    if (!child || child.exitCode !== null) continue;
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
    log(name, "stopped");
  }

  releaseSingleInstance();
  setTimeout(() => process.exit(0), 1500);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function main() {
  console.log(
    `\nAOS supervisor\n` +
      `  root        ${ROOT}\n` +
      `  web         ${process.env.AOS_WEB_HOST ?? "127.0.0.1"}:${WEB_PORT}\n` +
      `  api         ${process.env.AOS_API_HOST ?? "127.0.0.1"}:${API_PORT}\n` +
      `  storage     127.0.0.1:${STORAGE_PORT} (loopback only, always)\n` +
      `  mail        127.0.0.1:${MAIL_PORT} (loopback only, always)\n` +
      `  database    ${process.env.AOS_DB_NAME ?? "aos"} on ${process.env.AOS_DB_HOST ?? "127.0.0.1"}\n`,
  );

  claimSingleInstance();

  /**
   * Clear our own orphans before starting anything.
   *
   * PROVEN NECESSARY, not theoretical: the first end-to-end run of this
   * supervisor was force-killed rather than signalled, and its web-server
   * child survived holding port 4300 — Windows does not tear down a process
   * tree when an ancestor dies. Without this sweep the next start finds every
   * port taken, crash-loops on EADDRINUSE, and the office arrives to an AOS
   * that "did not come back after the reboot" for a reason nobody can see.
   *
   * Only AOS's own four ports, and only PIDs confirmed to be node.exe — the
   * same discipline `free-dev-ports.mjs` has always applied. It will never
   * touch PostgreSQL, which is not a Node process and not on these ports.
   */
  await freePorts([WEB_PORT, API_PORT, STORAGE_PORT, MAIL_PORT], "supervis");

  await waitForPostgres();

  for (const service of SERVICES) {
    log(service.name, "starting");
    start(service);
    const healthy = await waitForHealth(service.health, 30_000);
    log(service.name, healthy ? "healthy" : "did NOT become healthy in 30s — continuing, it will keep retrying");
  }

  log("supervis", "all services started. Ctrl-C to stop everything.");
}

await main();
