#!/usr/bin/env node
/**
 * Minimal local document storage backend.
 *
 * Scope, deliberately narrow: bytes in, bytes out, list-by-prefix, and
 * "open this folder in Explorer" — the four operations `StorageAdapter`
 * (src/domain/storage/storage-adapter.ts) needs. Nothing else. This is not
 * a general API server; case/requirement/verification logic all stays in
 * the frontend's fake store, same as today.
 *
 * Storage root is configurable (env var wins, then a small persisted
 * config file, then the default) so the office install isn't stuck with
 * whatever path was hardcoded at build time. Bytes land on disk under
 * `<root>/Documents/<path>`, where `<path>` is exactly what
 * `buildStoragePath` (src/domain/storage/path.ts) already computes —
 * `{ownerKind}/{ownerId}/{documentTypeCode}[/{financialYear}]/v{version}-{fileName}`
 * — so the on-disk hierarchy is Owner → Document Type → Financial Year →
 * Version, unchanged from what the domain layer already decided.
 *
 * A `.meta.json` sidecar next to each file carries what a filesystem
 * doesn't: content type and the original stored-at timestamp (mtime drifts
 * on copy/backup; this doesn't).
 */

import { createServer } from "node:http";
import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { listenOrExplain } from "./listen.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "storage.config.json");
const DEFAULT_ROOT = "C:\\AOS\\Data";
const PORT = Number(process.env.AOS_STORAGE_PORT ?? 4319);

async function loadConfiguredRoot() {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.root === "string" && parsed.root.trim()) return parsed.root;
  } catch {
    // No config file yet, or it's unreadable — fall through to the default.
  }
  return DEFAULT_ROOT;
}

let currentRoot = process.env.AOS_STORAGE_ROOT?.trim() || (await loadConfiguredRoot());

async function persistRoot(root) {
  await writeFile(CONFIG_PATH, JSON.stringify({ root }, null, 2) + "\n", "utf8");
}

function documentsRoot() {
  return path.join(currentRoot, "Documents");
}

/** Rejects `..` segments and absolute-path escapes so a crafted object path
 * can never write or read outside `documentsRoot()`. */
function resolveObjectPath(objectPath) {
  const segments = objectPath.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Invalid path.");
  }
  const resolved = path.join(documentsRoot(), ...segments);
  if (!resolved.startsWith(path.join(documentsRoot(), path.sep)) && resolved !== documentsRoot()) {
    throw new Error("Invalid path.");
  }
  return resolved;
}

function metaPathFor(filePath) {
  return `${filePath}.meta.json`;
}

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handlePut(req, res, objectPath) {
  const contentType = req.headers["content-type"] || undefined;
  const bytes = await readBody(req);
  const filePath = resolveObjectPath(objectPath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
  const storedAt = new Date().toISOString();
  await writeFile(
    metaPathFor(filePath),
    JSON.stringify({ contentType, storedAt, sizeBytes: bytes.byteLength }),
    "utf8",
  );
  json(res, 200, {
    path: objectPath,
    sizeBytes: bytes.byteLength,
    ...(contentType ? { contentType } : {}),
    storedAt,
  });
}

async function handleGet(req, res, objectPath) {
  const filePath = resolveObjectPath(objectPath);
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch {
    json(res, 404, { message: `No object at path "${objectPath}".` });
    return;
  }
  let contentType = "application/octet-stream";
  try {
    const meta = JSON.parse(await readFile(metaPathFor(filePath), "utf8"));
    if (meta.contentType) contentType = meta.contentType;
  } catch {
    // No sidecar — serve as a generic byte stream.
  }
  res.writeHead(200, { "Content-Type": contentType, "Access-Control-Allow-Origin": "*" });
  res.end(bytes);
}

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (!entry.name.endsWith(".meta.json")) {
      files.push(full);
    }
  }
  return files;
}

async function handleList(req, res, prefix) {
  const root = documentsRoot();
  const prefixSegments = prefix.split("/").filter(Boolean);
  const allFiles = await walk(root);
  const results = [];
  for (const filePath of allFiles) {
    const objectPath = path.relative(root, filePath).split(path.sep).join("/");
    if (!objectPath.startsWith(prefixSegments.join("/"))) continue;
    let contentType;
    let storedAt;
    try {
      const meta = JSON.parse(await readFile(metaPathFor(filePath), "utf8"));
      contentType = meta.contentType;
      storedAt = meta.storedAt;
    } catch {
      const info = await stat(filePath);
      storedAt = info.mtime.toISOString();
    }
    const info = await stat(filePath);
    results.push({
      path: objectPath,
      sizeBytes: info.size,
      ...(contentType ? { contentType } : {}),
      storedAt: storedAt ?? info.mtime.toISOString(),
    });
  }
  json(res, 200, results);
}

async function handleOpenFolder(req, res) {
  const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  const objectPath = typeof body.path === "string" ? body.path : "";
  if (!objectPath) {
    json(res, 400, { ok: false, message: "A path is required." });
    return;
  }
  let filePath;
  try {
    filePath = resolveObjectPath(objectPath);
  } catch {
    json(res, 400, { ok: false, message: "Invalid path." });
    return;
  }
  const folder = path.dirname(filePath);
  try {
    await stat(folder);
  } catch {
    json(res, 200, { ok: false, message: `Folder does not exist on disk: ${folder}` });
    return;
  }
  // explorer.exe routinely exits with status 1 even on success — spawned and
  // detached rather than awaited so that quirk can't be mistaken for failure.
  spawn("explorer.exe", [folder], { detached: true, stdio: "ignore" }).unref();
  json(res, 200, { ok: true, folder });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  const respondError = (error) => {
    json(res, 500, { message: error instanceof Error ? error.message : "Unexpected error." });
  };

  if (url.pathname === "/health" && req.method === "GET") {
    json(res, 200, { ok: true, root: currentRoot });
    return;
  }

  if (url.pathname === "/config" && req.method === "GET") {
    json(res, 200, { root: currentRoot });
    return;
  }

  if (url.pathname === "/config" && req.method === "PUT") {
    readBody(req)
      .then(async (buffer) => {
        const body = JSON.parse(buffer.toString("utf8") || "{}");
        if (typeof body.root !== "string" || !body.root.trim()) {
          json(res, 400, { message: "A non-empty root path is required." });
          return;
        }
        currentRoot = body.root.trim();
        await mkdir(documentsRoot(), { recursive: true });
        await persistRoot(currentRoot);
        json(res, 200, { root: currentRoot });
      })
      .catch(respondError);
    return;
  }

  if (url.pathname === "/objects" && req.method === "PUT") {
    const objectPath = url.searchParams.get("path") ?? "";
    handlePut(req, res, objectPath).catch(respondError);
    return;
  }

  if (url.pathname === "/objects" && req.method === "GET") {
    const objectPath = url.searchParams.get("path") ?? "";
    handleGet(req, res, objectPath).catch(respondError);
    return;
  }

  if (url.pathname === "/objects/list" && req.method === "GET") {
    const prefix = url.searchParams.get("prefix") ?? "";
    handleList(req, res, prefix).catch(respondError);
    return;
  }

  if (url.pathname === "/open-folder" && req.method === "POST") {
    handleOpenFolder(req, res).catch(respondError);
    return;
  }

  json(res, 404, { message: "Not found." });
});

await mkdir(documentsRoot(), { recursive: true });

/**
 * LOOPBACK, ALWAYS. This is not a configuration choice.
 *
 * This server has no authentication of any kind: anyone who can reach it can
 * read every customer's documents, overwrite them, and relocate the entire
 * store with `PUT /config`. Loopback binding IS the access control. The API
 * server (`Backend/api-server.ts`) is the only process that talks to it, and
 * it checks `document.read` / `document.upload` before a byte moves.
 *
 * Stage 4 made the API's bind address configurable so employee PCs could
 * finally reach AOS. This refusal is the other half of that change: it makes
 * sure the same reasoning is never applied here by analogy. If document bytes
 * ever need to leave this machine directly, the answer is authentication on
 * this server, not a wider bind — and this check should be the thing that
 * forces that conversation.
 */
const requestedHost = process.env.AOS_STORAGE_HOST?.trim();
if (requestedHost && requestedHost !== "127.0.0.1" && requestedHost !== "localhost") {
  console.error(
    `\n  Refusing to start: AOS_STORAGE_HOST is "${requestedHost}".\n` +
      `  The document storage backend has no authentication and must never listen\n` +
      `  beyond loopback. Employee PCs reach documents through the API server,\n` +
      `  which enforces permissions. See Docs/Deployment Topology.md.\n`,
  );
  process.exit(1);
}

listenOrExplain(server, PORT, "127.0.0.1", "document storage backend", () => {
  console.log(`AOS document storage backend listening on http://127.0.0.1:${PORT} (loopback only)`);
  console.log(`Storage root: ${currentRoot}`);
});
