/**
 * Automatic document organisation — where a document lives, computed rather
 * than chosen.
 *
 * Source of truth: BR-030 (exactly one owner), ADR-007 (documents belong to
 * people and properties, not cases), Database/migrations/0005's comment on
 * `document.file_path` ("a reference into object storage").
 *
 * Users never pick a folder. The path is a pure function of facts the system
 * already has — who the document belongs to, what type it is, which period
 * it covers, and which version this is — so the same document always lands
 * in the same place, and the hierarchy stays legible by inspection years from
 * now: owner, then document type, then (if period-scoped) financial year,
 * then version.
 */

import { financialYearOf } from "../requirements/financial-year.js";

export type DocumentOwnerKind = "person" | "property" | "organisation" | "case";

/** The single owner a document resolves to (BR-030: exactly one, never two). */
export interface DocumentOwner {
  readonly kind: DocumentOwnerKind;
  readonly id: string;
}

/**
 * The shape every document-like record carries today: a discriminator plus
 * up to four optional foreign keys, only one of which is set. Matches
 * `document.owner_kind` / `person_id` / `property_id` / `organisation_id` /
 * `case_id` in Database/migrations/0005 and `DocumentFile` in
 * Frontend/src/fake/types.ts.
 */
export interface DocumentOwnerFields {
  readonly ownerKind: DocumentOwnerKind;
  readonly personId?: string;
  readonly propertyId?: string;
  readonly organisationId?: string;
  readonly caseId?: string;
}

/**
 * Resolves the single owner from the four-optional-field shape. Throws if
 * `ownerKind` names a field that is not actually set — that is the
 * `document_owner_kind_matches` constraint (0005) restated in TypeScript, so
 * a bug that would fail the database check fails here first, at the point a
 * path is computed rather than silently producing a wrong path.
 */
export function resolveDocumentOwner(fields: DocumentOwnerFields): DocumentOwner {
  const id =
    fields.ownerKind === "person"
      ? fields.personId
      : fields.ownerKind === "property"
        ? fields.propertyId
        : fields.ownerKind === "organisation"
          ? fields.organisationId
          : fields.caseId;

  if (!id) {
    throw new Error(
      `Document owner kind "${fields.ownerKind}" has no matching id set (BR-030).`,
    );
  }

  return { kind: fields.ownerKind, id };
}

export interface DocumentPathInput {
  readonly owner: DocumentOwner;
  /** document_type.code, e.g. "pan", "gst_returns" — stable and human-legible,
   * unlike the type's uuid. */
  readonly documentTypeCode: string;
  /** 1 for a first upload; incremented by `nextVersion` for a replacement. */
  readonly version: number;
  /** Set only for period-scoped documents (ITR, GST returns, bank statements,
   * balance sheet, P&L — see FINANCIAL_YEAR_DOCUMENT_TYPES). Folds the period
   * into an "FY2024_25" segment so multiple years of the same document type
   * for the same owner don't collide or get mixed up. */
  readonly periodStart?: string;
  readonly fileName: string;
}

const UNSAFE_PATH_CHARACTERS = /[^a-zA-Z0-9._-]+/g;

/** Object storage keys are not filesystems: no arbitrary characters, no
 * ambiguity about the original name once one document type accumulates many
 * versions from many uploaders. */
function sanitizeFileName(fileName: string): string {
  const safe = fileName.trim().replace(UNSAFE_PATH_CHARACTERS, "_");
  return /[a-zA-Z0-9]/.test(safe) ? safe : "file";
}

/**
 * The one place a document's storage path is decided. Every caller — the
 * interactive upload flow today, and OCR / email / WhatsApp / bulk import
 * later — goes through this function rather than inventing its own layout,
 * which is what keeps the hierarchy from drifting into inconsistency as more
 * ingestion paths are added.
 *
 * Shape: `{ownerKind}/{ownerId}/{documentTypeCode}[/{financialYear}]/v{version}-{fileName}`
 *
 * Example: `person/8f2.../pan/v1-ravi-pan.pdf`
 * Example: `organisation/a91.../gst_returns/2024_25/v1-gstr-3b-q1.pdf`
 */
export function buildStoragePath(input: DocumentPathInput): string {
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new Error(`Document version must be a positive integer, got ${input.version}.`);
  }

  const periodSegment = input.periodStart
    ? `/${financialYearOf(new Date(input.periodStart)).label.replace("-", "_")}`
    : "";

  return [
    input.owner.kind,
    input.owner.id,
    `${input.documentTypeCode}${periodSegment}`,
    `v${input.version}-${sanitizeFileName(input.fileName)}`,
  ].join("/");
}
