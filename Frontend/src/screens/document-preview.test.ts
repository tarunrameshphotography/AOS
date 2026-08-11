import { describe, expect, it } from "vitest";

import {
  DOCUMENT_PREVIEW_MODES,
  documentPreviewMode,
  isViewableInBrowser,
  previewFallbackMessage,
} from "./document-preview.js";

/**
 * The rule this file guards: "View" means SEE IT, not "save it to Downloads".
 *
 * The bug it replaces was a synthetic `<a download>` in CaseDetail.tsx that
 * overrode the server's `Content-Disposition: inline`. Every previously
 * viewable type must therefore resolve to an on-screen mode here; only types
 * no browser renders may fall back to a download.
 */
describe("how a document is shown", () => {
  it("shows a PDF in the browser's own viewer rather than downloading it", () => {
    expect(documentPreviewMode("application/pdf", "pan-card.pdf")).toBe("pdf");
    expect(isViewableInBrowser("application/pdf", "pan-card.pdf")).toBe(true);
  });

  it("shows a photographed document as a picture", () => {
    expect(documentPreviewMode("image/jpeg", "aadhaar.jpg")).toBe("image");
    expect(documentPreviewMode("image/png", "salary-slip.png")).toBe("image");
    expect(documentPreviewMode("image/webp", "cheque.webp")).toBe("image");
  });

  it("ignores charset and casing on the content type", () => {
    expect(documentPreviewMode("APPLICATION/PDF; charset=binary", "x.pdf")).toBe("pdf");
    expect(documentPreviewMode("Image/JPEG", "x.jpg")).toBe("image");
  });

  it("falls back to the file name when the server would not commit to a type", () => {
    // The upload path stores whatever the browser sent; an unknown extension
    // arrives as octet-stream, and the name is the only remaining evidence.
    expect(documentPreviewMode("application/octet-stream", "bank-statement.pdf")).toBe("pdf");
    expect(documentPreviewMode("", "photo.JPEG")).toBe("image");
    expect(documentPreviewMode(null, "scan.png")).toBe("image");
    expect(documentPreviewMode(undefined, "scan.png")).toBe("image");
  });

  it("does not let the file name override a type the server did state", () => {
    // A .pdf name on a zip is either a mistake or an attack; the declared type
    // decides, and the fallback is the safe direction.
    expect(documentPreviewMode("application/zip", "not-really.pdf")).toBe("download_only");
  });

  it("refuses to pretend it can show a HEIC, which no browser renders", () => {
    expect(documentPreviewMode("image/heic", "IMG_0042.heic")).toBe("download_only");
    expect(documentPreviewMode("image/heif", "IMG_0042.heif")).toBe("download_only");
    expect(isViewableInBrowser("image/heic", "IMG_0042.heic")).toBe(false);
  });

  it("offers a download only for what it genuinely cannot show", () => {
    for (const type of [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/zip",
    ]) {
      expect(documentPreviewMode(type, "file.bin")).toBe("download_only");
    }
  });

  it("never invents a mode outside the three it declares", () => {
    for (const input of ["application/pdf", "image/png", "text/plain", "", "nonsense"]) {
      expect(DOCUMENT_PREVIEW_MODES).toContain(documentPreviewMode(input, "x"));
    }
  });

  it("names the file and says what to do next when it cannot be shown", () => {
    const message = previewFallbackMessage("form-16.docx");
    expect(message).toContain("form-16.docx");
    expect(message.toLowerCase()).toContain("download");
    // No file name at all is still a usable sentence, not "undefined is not…".
    expect(previewFallbackMessage(null)).not.toContain("null");
    expect(previewFallbackMessage("")).toContain("This file");
  });
});
