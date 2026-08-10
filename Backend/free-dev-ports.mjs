#!/usr/bin/env node
/**
 * Frees AOS's own dev ports before `npm run dev` starts.
 *
 * On Windows, killing the top-level `concurrently` process (closing the
 * terminal, ending the shell) does not cascade to its children: each dev
 * command runs under its own `cmd.exe` wrapper, and Windows has no default
 * mechanism that tears down a process tree when an ancestor dies. The
 * storage/mail/api/vite processes survive as orphans, still bound to their
 * ports, and the next `npm run dev` fails with EADDRINUSE.
 *
 * This is a startup safety net, not a substitute for clean shutdown: it only
 * ever touches the four ports AOS's own dev stack listens on, and only kills
 * a PID after confirming it's a `node.exe` process — never a blind sweep.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const AOS_DEV_PORTS = [
  Number(process.env.AOS_VITE_PORT ?? 5173),
  Number(process.env.AOS_API_PORT ?? 4321),
  Number(process.env.AOS_STORAGE_PORT ?? 4319),
  Number(process.env.AOS_MAIL_PORT ?? 4320),
];

/** Every LISTENING PID on `port`, IPv4 or IPv6 — `-p tcp` silently drops
 * IPv6 rows on some Windows builds, so the raw table is parsed instead. */
let windowsListenTableCache = null;
async function windowsListenTable() {
  if (windowsListenTableCache) return windowsListenTableCache;
  const { stdout } = await execFileAsync("netstat", ["-ano"]);
  windowsListenTableCache = stdout.split(/\r?\n/);
  return windowsListenTableCache;
}

async function pidsListeningOnWindows(port) {
  const lines = await windowsListenTable();
  const pids = new Set();
  for (const line of lines) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== "TCP" || columns[3] !== "LISTENING") continue;
    const localAddress = columns[1] ?? "";
    if (!localAddress.endsWith(`:${port}`)) continue;
    pids.add(columns[4]);
  }
  return [...pids];
}

async function pidsListeningOnPosix(port) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("lsof", ["-t", `-i:${port}`, "-sTCP:LISTEN"]));
  } catch {
    return [];
  }
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function isNodeProcess(pid) {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]).catch(
      () => ({ stdout: "" }),
    );
    return /^"node\.exe"/i.test(stdout.trim());
  }
  const { stdout } = await execFileAsync("ps", ["-o", "comm=", "-p", pid]).catch(() => ({ stdout: "" }));
  return /node$/.test(stdout.trim());
}

async function killPid(pid) {
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/PID", pid, "/F"]).catch(() => {});
  } else {
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

async function freePort(port) {
  const pids = process.platform === "win32" ? await pidsListeningOnWindows(port) : await pidsListeningOnPosix(port);
  for (const pid of pids) {
    if (!(await isNodeProcess(pid))) continue; // Never touch a non-Node process on our ports.
    console.log(`[free-dev-ports] Port ${port} held by leftover node.exe (PID ${pid}) — killing it.`);
    await killPid(pid);
  }
}

await Promise.all(AOS_DEV_PORTS.map(freePort));
