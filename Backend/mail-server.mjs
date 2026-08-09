#!/usr/bin/env node
/**
 * The local mail backend — the one place in AOS that knows what Gmail is.
 *
 * Scope, deliberately narrow, exactly as `storage-server.mjs` is narrow: take
 * one fully-composed message and send it. It does not choose recipients, write
 * subjects, split attachments or decide what is verified — all of that is
 * domain logic in src/domain/submissions and stays there. This process exists
 * because two things cannot happen in a browser tab: holding an OAuth refresh
 * token, and speaking to Gmail's API without CORS.
 *
 *   AOS submission domain
 *          ↓
 *   EmailProvider              src/domain/communications/email-provider.ts
 *          ↓
 *   HttpEmailProvider          Frontend/src/fake/mail.ts
 *          ↓
 *   THIS FILE
 *          ↓
 *   Gmail API
 *
 * THREE PROVIDERS, AND THE DEFAULT REFUSES.
 *
 *   unconfigured  The default. Every send is refused with `not_configured`.
 *                 It does not queue, does not log-and-continue and never
 *                 reports success. A prototype that quietly "sends" mail
 *                 nobody receives is worse than one that cannot send, because
 *                 the case timeline would record a submission that never
 *                 happened and somebody would stop chasing the bank.
 *
 *   gmail         Real delivery, via OAuth2. Requires the four AOS_GMAIL_*
 *                 variables below. No password is stored anywhere, ever.
 *
 *   capture       FOR TESTS ONLY. Writes the message to disk instead of
 *                 sending it and reports success. Enabled only by explicitly
 *                 setting AOS_MAIL_PROVIDER=capture, announced loudly at
 *                 startup, and never reachable by accident — the Playwright
 *                 suite sets it, and nothing else should.
 *
 * NOTHING IN THIS FILE IS A CREDENTIAL. Every secret comes from the
 * environment. See .env.example.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load `.env` from the repository root, if there is one.
 *
 * Fifteen lines rather than `dotenv`, and rather than `node --env-file`: that
 * flag fails outright when the file is absent on the Node versions this repo
 * supports, and an office install that has not been configured yet should
 * start and say so, not crash. A variable already in the real environment
 * always wins, so `AOS_MAIL_PROVIDER=capture npm run dev` overrides the file
 * — which is how the Playwright suite selects the test provider.
 */
function loadDotEnv() {
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
    // No .env — every value below falls back to its documented default.
  }
}

loadDotEnv();

const PORT = Number(process.env.AOS_MAIL_PORT ?? 4320);
const PROVIDER = (process.env.AOS_MAIL_PROVIDER ?? "unconfigured").trim().toLowerCase();

/**
 * The mailbox AOS sends as.
 *
 * This is a DEFAULT for display, not an authorisation. Gmail sends as
 * whichever account the refresh token belongs to regardless of what is put on
 * the From line — which is the correct behaviour and the reason this file
 * never fakes a From header. If the two disagree, Gmail wins and the header is
 * rewritten by them, not by us.
 */
const SENDER_ADDRESS = process.env.AOS_MAIL_SENDER_ADDRESS ?? "amazeloans@gmail.com";
const SENDER_NAME = process.env.AOS_MAIL_SENDER_NAME ?? "Amaze Loans";

const SEND_TIMEOUT_MS = Number(process.env.AOS_MAIL_TIMEOUT_MS ?? 60_000);

// ---------------------------------------------------------------------------
// RFC 5322 / 2045 message construction.
//
// Hand-rolled rather than pulled from npm, and that is a considered choice:
// the shape below is a plain-text body plus base64 attachments, which is about
// eighty lines, and a mail library brings a transport, a template engine and a
// dependency tree into a repository whose whole dependency list currently fits
// on one screen.
// ---------------------------------------------------------------------------

/** RFC 2047 encoded-word, for a header value that is not plain ASCII. */
function encodeHeaderValue(value) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** `"Karthik V" <karthik@bank.com>`, or the bare address when no name is known. */
function formatAddress(address) {
  const email = String(address.email ?? "").trim();
  const name = typeof address.name === "string" ? address.name.trim() : "";
  if (name === "") return email;
  // A quoted display name may not contain a bare quote or backslash.
  const safe = name.replace(/[\\"]/g, " ").trim();
  return `"${encodeHeaderValue(safe)}" <${email}>`;
}

/** Base64, wrapped at 76 characters with CRLF, as RFC 2045 requires. */
function base64Lines(buffer) {
  const encoded = buffer.toString("base64");
  const lines = [];
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76));
  }
  return lines.join("\r\n");
}

/**
 * `Content-Disposition` for an attachment.
 *
 * Both forms are emitted: a plain ASCII `filename=` every client understands,
 * and RFC 2231's `filename*=` carrying the real name. Indian document scans
 * routinely arrive with names no ASCII fallback can represent, and a banker
 * receiving "attachment-3" instead of "Patta & Chitta.pdf" is a phone call.
 */
function contentDisposition(fileName) {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(fileName);
  return `Content-Disposition: attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function buildMimeMessage(message) {
  const boundary = `aos_${randomUUID().replace(/-/g, "")}`;
  const lines = [];

  lines.push(`From: ${formatAddress(message.from)}`);
  lines.push(`To: ${message.to.map(formatAddress).join(", ")}`);
  if (Array.isArray(message.cc) && message.cc.length > 0) {
    lines.push(`Cc: ${message.cc.map(formatAddress).join(", ")}`);
  }
  lines.push(`Subject: ${encodeHeaderValue(message.subject)}`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push(`Message-ID: <${randomUUID()}@amazeloans>`);
  lines.push("MIME-Version: 1.0");
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push("");

  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(base64Lines(Buffer.from(message.body, "utf8")));

  for (const attachment of message.attachments) {
    const bytes = Buffer.from(attachment.base64, "base64");
    lines.push(`--${boundary}`);
    lines.push(
      `Content-Type: ${attachment.contentType || "application/octet-stream"}; name="${attachment.fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_")}"`,
    );
    lines.push(contentDisposition(attachment.fileName));
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(base64Lines(bytes));
  }

  lines.push(`--${boundary}--`);
  lines.push("");

  return Buffer.from(lines.join("\r\n"), "utf8");
}

// ---------------------------------------------------------------------------
// Gmail.
//
// OAuth2 with a long-lived REFRESH TOKEN, which is the correct mechanism for
// amazeloans@gmail.com specifically: a service account with domain-wide
// delegation only works against a Google Workspace domain, and a consumer
// gmail.com mailbox is not one. If Amaze moves to Workspace, the delegation
// route becomes available and only this section changes.
//
// No password is involved at any point, and none can be — Gmail has not
// accepted one from an application since 2022.
// ---------------------------------------------------------------------------

const GMAIL = {
  clientId: process.env.AOS_GMAIL_CLIENT_ID ?? "",
  clientSecret: process.env.AOS_GMAIL_CLIENT_SECRET ?? "",
  refreshToken: process.env.AOS_GMAIL_REFRESH_TOKEN ?? "",
};

function gmailMisconfiguration() {
  const missing = [];
  if (!GMAIL.clientId) missing.push("AOS_GMAIL_CLIENT_ID");
  if (!GMAIL.clientSecret) missing.push("AOS_GMAIL_CLIENT_SECRET");
  if (!GMAIL.refreshToken) missing.push("AOS_GMAIL_REFRESH_TOKEN");
  return missing;
}

/** Cached until shortly before expiry — Google issues these for an hour. */
let accessToken = null;

async function gmailAccessToken() {
  if (accessToken && accessToken.expiresAt > Date.now() + 60_000) {
    return accessToken.value;
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL.clientId,
      client_secret: GMAIL.clientSecret,
      refresh_token: GMAIL.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error_description ?? payload.error ?? `HTTP ${response.status}`;
    const error = new Error(`Google refused the refresh token: ${detail}`);
    error.aosFailureKind = "authentication";
    throw error;
  }

  accessToken = {
    value: payload.access_token,
    expiresAt: Date.now() + Number(payload.expires_in ?? 3600) * 1000,
  };
  return accessToken.value;
}

/**
 * Send through Gmail.
 *
 * The `/upload/` endpoint with `uploadType=media` is used rather than the
 * plain JSON `messages.send`: the JSON form carries the whole message
 * base64url-encoded inside a request body and is limited well below what a
 * ten-megabyte attachment set needs once encoded. The upload form takes the
 * raw RFC 822 bytes and accepts up to 35 MB.
 */
async function gmailSend(message) {
  const token = await gmailAccessToken();
  const raw = buildMimeMessage(message);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(
      "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "message/rfc822",
        },
        body: raw,
        signal: controller.signal,
      },
    );
  } catch (error) {
    const failure = new Error(
      error?.name === "AbortError"
        ? `Gmail did not answer within ${Math.round(SEND_TIMEOUT_MS / 1000)} seconds.`
        : `Could not reach Gmail: ${error?.message ?? "network error"}`,
    );
    failure.aosFailureKind = error?.name === "AbortError" ? "timeout" : "network";
    throw failure;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let detail = text;
    try {
      detail = JSON.parse(text)?.error?.message ?? text;
    } catch {
      // Not JSON — the raw body is the best detail available.
    }
    const failure = new Error(detail || `Gmail returned HTTP ${response.status}.`);
    failure.aosFailureKind = classifyGmailStatus(response.status, detail);
    // A 401 means the cached token is no longer good; drop it so the next
    // attempt re-authenticates rather than replaying a dead token.
    if (response.status === 401) accessToken = null;
    throw failure;
  }

  const payload = await response.json().catch(() => ({}));
  return { providerMessageId: payload.id };
}

function classifyGmailStatus(status, detail) {
  if (status === 401 || status === 403) return "authentication";
  if (status === 413) return "attachment_too_large";
  if (status === 429 || status >= 500) return "network";
  if (status === 400 && /address|recipient|invalid to|invalid cc/i.test(detail ?? "")) {
    return "invalid_recipient";
  }
  return "rejected_by_provider";
}

// ---------------------------------------------------------------------------
// Capture — the test provider.
//
// Explicit, named, and impossible to enable by accident. It exists so the
// Playwright suite can drive the real UI all the way through a send without a
// credential and without mailing a real bank, and so that what the UI produced
// can be read back and asserted on.
// ---------------------------------------------------------------------------

const CAPTURE_DIR =
  process.env.AOS_MAIL_CAPTURE_DIR ?? path.join(__dirname, "captured-mail");

let captureSeq = 0;

async function captureSend(message) {
  await mkdir(CAPTURE_DIR, { recursive: true });
  captureSeq += 1;
  const id = `capture-${String(captureSeq).padStart(4, "0")}-${Date.now()}`;
  const record = {
    providerMessageId: id,
    capturedAt: new Date().toISOString(),
    submissionPackageEmailId: message.submissionPackageEmailId,
    from: message.from,
    to: message.to,
    cc: message.cc ?? [],
    subject: message.subject,
    body: message.body,
    attachments: message.attachments.map((attachment) => ({
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      sizeBytes: Buffer.from(attachment.base64, "base64").byteLength,
    })),
    // Built so the capture proves the same MIME path a real send takes runs
    // and produces something well-formed, rather than testing a shortcut.
    mimeBytes: buildMimeMessage(message).byteLength,
  };
  await writeFile(path.join(CAPTURE_DIR, `${id}.json`), JSON.stringify(record, null, 2), "utf8");
  return { providerMessageId: id };
}

async function readCaptured() {
  try {
    const names = (await readdir(CAPTURE_DIR)).filter((name) => name.endsWith(".json")).sort();
    return await Promise.all(
      names.map(async (name) => JSON.parse(await readFile(path.join(CAPTURE_DIR, name), "utf8"))),
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// HTTP.
// ---------------------------------------------------------------------------

function json(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** The one shape every provider answers in — `EmailSendResult` in the domain. */
function failureResult(submissionPackageEmailId, kind, message) {
  return { ok: false, submissionPackageEmailId, failure: { kind, message } };
}

function validate(message) {
  if (typeof message?.submissionPackageEmailId !== "string" || message.submissionPackageEmailId === "") {
    return "submissionPackageEmailId is required.";
  }
  if (!Array.isArray(message.to) || message.to.length === 0) {
    return "At least one recipient is required.";
  }
  for (const address of [...message.to, ...(message.cc ?? [])]) {
    if (!/^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(String(address?.email ?? "").trim())) {
      return `"${address?.email ?? ""}" does not look like an email address.`;
    }
  }
  if (typeof message.subject !== "string" || message.subject.trim() === "") {
    return "A subject is required.";
  }
  if (!Array.isArray(message.attachments)) {
    return "attachments must be a list.";
  }
  return null;
}

async function handleSend(req, res) {
  let message;
  try {
    message = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  } catch {
    json(res, 400, failureResult("", "unknown", "The request body was not valid JSON."));
    return;
  }

  const invalid = validate(message);
  if (invalid) {
    // 200 with ok:false, not an HTTP error: this is a business refusal the
    // caller records against a specific email row, not a transport fault.
    json(res, 200, failureResult(message.submissionPackageEmailId ?? "", "invalid_recipient", invalid));
    return;
  }

  const from = {
    email: message.from?.email ?? SENDER_ADDRESS,
    name: message.from?.name ?? SENDER_NAME,
  };
  const prepared = { ...message, from };

  if (PROVIDER === "unconfigured") {
    const missing = gmailMisconfiguration();
    json(
      res,
      200,
      failureResult(
        message.submissionPackageEmailId,
        "not_configured",
        "No email provider is configured for this installation of AOS. Set AOS_MAIL_PROVIDER=gmail " +
          `and provide ${missing.join(", ")} — see .env.example and Docs/Email and WhatsApp Integration.md. Nothing was sent.`,
      ),
    );
    return;
  }

  if (PROVIDER === "gmail") {
    const missing = gmailMisconfiguration();
    if (missing.length > 0) {
      json(
        res,
        200,
        failureResult(
          message.submissionPackageEmailId,
          "not_configured",
          `AOS_MAIL_PROVIDER is gmail but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. Nothing was sent.`,
        ),
      );
      return;
    }
  }

  try {
    const sent = PROVIDER === "capture" ? await captureSend(prepared) : await gmailSend(prepared);
    json(res, 200, {
      ok: true,
      submissionPackageEmailId: message.submissionPackageEmailId,
      ...(sent.providerMessageId ? { providerMessageId: sent.providerMessageId } : {}),
      sentAt: new Date().toISOString(),
    });
  } catch (error) {
    json(
      res,
      200,
      failureResult(
        message.submissionPackageEmailId,
        error?.aosFailureKind ?? "unknown",
        error?.message ?? "The mail provider failed for an unknown reason.",
      ),
    );
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (url.pathname === "/health" && req.method === "GET") {
    json(res, 200, {
      ok: true,
      provider: PROVIDER,
      configured: PROVIDER === "capture" || (PROVIDER === "gmail" && gmailMisconfiguration().length === 0),
      sender: { address: SENDER_ADDRESS, name: SENDER_NAME },
      ...(PROVIDER === "gmail" ? { missing: gmailMisconfiguration() } : {}),
    });
    return;
  }

  if (url.pathname === "/send" && req.method === "POST") {
    handleSend(req, res).catch((error) => {
      json(res, 500, failureResult("", "unknown", error?.message ?? "Unexpected error."));
    });
    return;
  }

  // Test-only, and only under the test provider. Exposing what was "sent" is
  // exactly the kind of endpoint that must not exist against a real mailbox.
  if (url.pathname === "/captured" && req.method === "GET" && PROVIDER === "capture") {
    readCaptured()
      .then((records) => json(res, 200, records))
      .catch(() => json(res, 200, []));
    return;
  }

  json(res, 404, { message: "Not found." });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`AOS mail backend listening on http://127.0.0.1:${PORT}`);
  if (PROVIDER === "capture") {
    console.log("");
    console.log("  *** MAIL PROVIDER: capture — NOTHING WILL BE SENT ***");
    console.log(`  Messages are written to ${CAPTURE_DIR} instead.`);
    console.log("  This mode is for automated tests. Never run an office install this way.");
    console.log("");
  } else if (PROVIDER === "gmail") {
    const missing = gmailMisconfiguration();
    console.log(
      missing.length === 0
        ? `  Provider: gmail, sending as ${SENDER_NAME} <${SENDER_ADDRESS}>`
        : `  Provider: gmail, but NOT USABLE — missing ${missing.join(", ")}. Sends will be refused.`,
    );
  } else {
    console.log("  Provider: unconfigured. Every send will be refused, on purpose.");
    console.log("  See .env.example to connect the Amaze Loans mailbox.");
  }
});
