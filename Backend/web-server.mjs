#!/usr/bin/env node
/**
 * The office web server: serves the built AOS frontend, and proxies `/api` to
 * the API process.
 *
 * WHY THIS EXISTS (Stage 4 audit, C1/H6). The frontend calls `/api/...` on its
 * own origin and depended entirely on the VITE DEV SERVER's proxy
 * (`vite.config.ts`) to reach the API. That is the only thing in the
 * repository that had ever joined the two halves together, which meant the
 * office had exactly two options, both wrong:
 *
 *   - Run `vite` in production. An unminified, source-mapped dev server with a
 *     watcher, held up by a console window somebody will eventually close.
 *   - Have each employee run the whole backend on their own PC, which
 *     `Docs/Deployment Topology.md` forbids because their local disk silently
 *     becomes a second, disconnected document store.
 *
 * So: one small process, no dependencies, that does the two things the office
 * actually needs. `npm run build` produces `Frontend/dist`; this serves it and
 * forwards `/api` to `AOS_API_PORT`, keeping the browser's requests
 * same-origin exactly as they are in development. Nothing about the frontend
 * changes between a developer's machine and the office.
 *
 * WHY IT PROXIES RATHER THAN POINTING THE BROWSER AT PORT 4321 DIRECTLY:
 * same-origin means no CORS preflight on every mutation, one address for
 * employees to bookmark, and one port to open in the firewall instead of two.
 * It also means the API can go back to loopback the day a reverse proxy or
 * TLS terminator is put in front of all of this.
 *
 * Usage:
 *   npm run build          once, whenever the frontend changes
 *   npm run web-server     serve it
 *
 * Configuration:
 *   AOS_WEB_PORT   default 4300 — what employees put in their browser
 *   AOS_WEB_HOST   default 127.0.0.1; the office server sets 0.0.0.0
 *   AOS_API_PORT   default 4321 — where /api is forwarded, always loopback
 */

import { createServer, request as httpRequest } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotEnv } from "./env.mjs";
import { listenOrExplain } from "./listen.mjs";

loadDotEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "..", "Frontend", "dist");

const PORT = Number(process.env.AOS_WEB_PORT ?? 4300);
const HOST = process.env.AOS_WEB_HOST?.trim() || "127.0.0.1";
const API_PORT = Number(process.env.AOS_API_PORT ?? 4321);

/**
 * The API is reached over loopback even when this server is on the LAN.
 *
 * That is the point of the split: employees talk to THIS process, which is the
 * only one listening on the network, and it is the only thing that talks to
 * the API. Setting AOS_API_HOST=0.0.0.0 as well is possible but unnecessary —
 * and every port not open is a port nobody has to reason about.
 */
const API_HOST = "127.0.0.1";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

/**
 * Resolve a URL path to a file inside `dist`, or null.
 *
 * The `startsWith` check is the load-bearing one, not the `..` filter: on
 * Windows a segment can contain a backslash, which `path.join` treats as a
 * separator, so filtering for a literal `..` segment alone would not be
 * enough. Comparing the RESOLVED path against the root catches every spelling
 * — the same belt-and-braces `storage-server.mjs` uses.
 */
function resolveAsset(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const segments = decoded.split("/").filter((segment) => segment && segment !== ".");
  const resolved = path.resolve(DIST, ...segments);
  if (resolved !== DIST && !resolved.startsWith(DIST + path.sep)) return null;
  return resolved;
}

async function serveFile(res, filePath, { immutable }) {
  let info;
  try {
    info = await stat(filePath);
    if (!info.isFile()) return false;
  } catch {
    return false;
  }

  res.writeHead(200, {
    "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": info.size,
    // Vite fingerprints everything under /assets, so those may be cached
    // forever. index.html must not be: it is the file that names the current
    // fingerprints, and a cached copy is how an employee ends up running last
    // week's frontend against this week's API after a deploy.
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-store",
    // The app loads nothing from anywhere else, so say so. Cheap defence
    // against an injected script trying to exfiltrate a case list.
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
  });
  createReadStream(filePath).pipe(res);
  return true;
}

/** Forward a request to the API process verbatim, streaming both ways. */
function proxyToApi(req, res) {
  const upstream = httpRequest(
    {
      host: API_HOST,
      port: API_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${API_HOST}:${API_PORT}` },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on("error", () => {
    // The API process is down. Answered in the same shape every other AOS
    // error uses — `{ message }` — because the browser's `api()` client reads
    // that field and shows it to the employee. A bare 502 would surface as
    // "Something went wrong", which does not say who to tell.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const body = JSON.stringify({
      message:
        "AOS is running but its API is not responding. Nothing was saved. " +
        "The AOS server PC needs attention — the API service may have stopped.",
    });
    res.writeHead(503, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  });

  req.pipe(upstream);
}

const server = createServer((req, res) => {
  void (async () => {
    const url = req.url ?? "/";

    if (url === "/health" || url.startsWith("/health?")) {
      const body = JSON.stringify({ ok: true, service: "aos-web" });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    if (url === "/api" || url.startsWith("/api/")) {
      proxyToApi(req, res);
      return;
    }

    const pathname = url.split("?")[0];
    const asset = resolveAsset(pathname);
    if (asset) {
      const immutable = pathname.startsWith("/assets/");
      if (await serveFile(res, asset, { immutable })) return;
    }

    // Anything else is a client-side route (`/cases/<id>`, `/admin/users`).
    // React Router owns those, so the shell is served and the browser resolves
    // it — which is what makes a bookmarked case URL work after a refresh.
    if (await serveFile(res, path.join(DIST, "index.html"), { immutable: false })) return;

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found.");
  })().catch(() => {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Something went wrong.");
    }
  });
});

if (!existsSync(path.join(DIST, "index.html"))) {
  console.error(
    `\n  There is no built frontend at ${DIST}.\n` +
      `  Run \`npm run build\` first — this server serves the build, it does not\n` +
      `  compile anything. (In development use \`npm run dev\` instead.)\n`,
  );
  process.exit(1);
}

listenOrExplain(server, PORT, HOST, "web server", () => {
  console.log(`AOS web server listening on http://${HOST}:${PORT}`);
  console.log(`  Serving ${DIST}`);
  console.log(`  /api -> http://${API_HOST}:${API_PORT}`);
  if (HOST === "127.0.0.1" || HOST === "localhost") {
    console.log("  Loopback only — no other PC can reach this. Set AOS_WEB_HOST=0.0.0.0 on the office server.");
  } else {
    console.log(`\n  *** EMPLOYEES REACH AOS AT http://<this PC's LAN IP>:${PORT} ***`);
    console.log("  Only the designated AOS server PC should be doing this — see Docs/Deployment Topology.md.\n");
  }
});
