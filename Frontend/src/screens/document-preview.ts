/**
 * How a document's bytes should be SHOWN, given what kind of file it is.
 *
 * WHY THIS IS A SEPARATE, PURE MODULE: the bug this replaces was that "View"
 * fetched the bytes and then forced a save with a synthetic `<a download>`.
 * The server had already said `Content-Disposition: inline`
 * (Backend/api-server.ts) — the browser was told to display it and the UI
 * overrode that. Deciding *how* to display is a rule about file types, not
 * about React, so it lives here where it can be tested without a DOM. The
 * screen renders whatever this returns.
 *
 * The vocabulary is deliberately small. AOS receives PAN cards, Aadhaars,
 * salary slips and bank statements — in practice PDFs and phone photographs.
 * Anything else is honestly reported as "not viewable here" with a download
 * offered, rather than being silently downloaded as if that were the same
 * thing as viewing it.
 */

/**
 * `image` — an `<img>` with an object URL.
 * `pdf`   — the browser's own PDF viewer, via `<embed>`/`<iframe>`.
 * `download_only` — nothing the browser renders reliably (Word, Excel, zip).
 *   The employee is told so and given a download, which is a fallback, not the
 *   default path.
 */
export type DocumentPreviewMode = "image" | "pdf" | "download_only";

export const DOCUMENT_PREVIEW_MODES: readonly DocumentPreviewMode[] = [
  "image",
  "pdf",
  "download_only",
];

/**
 * Extensions we map ourselves when the transport does not tell us the type.
 *
 * Mirrors `contentTypeFor` in Backend/submissions.ts for the types that are
 * viewable; anything absent falls through to `download_only`, which is the
 * safe direction to be wrong in — a file shown as a broken image teaches
 * nothing, a file offered as a download always works.
 */
const VIEWABLE_EXTENSIONS: Record<string, DocumentPreviewMode> = {
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  // HEIC is what an iPhone produces and what no desktop browser renders. It is
  // deliberately NOT here: pretending to show it would give the login desk a
  // blank box and no way forward.
};

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0 || dot === fileName.length - 1) return "";
  return fileName.slice(dot + 1).toLowerCase();
}

/**
 * Decide how to show a document.
 *
 * `mimeType` is what the server sent (the blob's own `type`), and it wins when
 * it is meaningful. `application/octet-stream` and an empty string are not
 * meaningful — they mean "I don't know" — so the file name is consulted next.
 */
export function documentPreviewMode(
  mimeType: string | null | undefined,
  fileName?: string | null,
): DocumentPreviewMode {
  const type = (mimeType ?? "").trim().toLowerCase().split(";")[0] ?? "";

  if (type === "application/pdf") return "pdf";
  // `image/heic` matches `image/` but no browser renders it — excluded by name
  // rather than by prefix, so an honest fallback is offered instead of a
  // broken picture.
  if (type.startsWith("image/") && type !== "image/heic" && type !== "image/heif") {
    return "image";
  }

  if (type === "" || type === "application/octet-stream") {
    const byExtension = VIEWABLE_EXTENSIONS[extensionOf(fileName ?? "")];
    if (byExtension) return byExtension;
  }

  return "download_only";
}

/** True when the browser can show this document without downloading it. */
export function isViewableInBrowser(
  mimeType: string | null | undefined,
  fileName?: string | null,
): boolean {
  return documentPreviewMode(mimeType, fileName) !== "download_only";
}

/**
 * What to tell somebody whose document cannot be shown on screen.
 *
 * Names the file, so a login executive with four dialogs open knows which one
 * is refusing, and says what to do next rather than only what failed.
 */
export function previewFallbackMessage(fileName?: string | null): string {
  const named = fileName && fileName.trim().length > 0 ? fileName.trim() : "This file";
  return `${named} is not a type this browser can display. Download it to open it in another application.`;
}
