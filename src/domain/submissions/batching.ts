/**
 * Splitting a set of verified documents across outgoing emails.
 *
 * Source of truth: ADR-039.
 *
 * THE PROBLEM. A business file is thirty megabytes of scans and no mail
 * provider will take that in one message. Somebody in the office currently
 * solves this by attaching files until Gmail complains, then starting a second
 * email — which is why a banker regularly receives two of one year's GST
 * return and none of another, and why "did you get the ITRs?" is a phone call
 * that happens every week.
 *
 * THE RULE. No individual email exceeds the ceiling
 * (`MAX_ATTACHMENT_BYTES_PER_EMAIL`), every selected document appears in
 * EXACTLY ONE email, and nothing is dropped. Those three together are the
 * whole contract, and `batching.test.ts` asserts all three over generated
 * inputs rather than over three hand-picked examples.
 *
 * WHY GROUPING AND NOT JUST PACKING. A bin-packing algorithm would produce
 * fuller emails. It would also put the GST certificate in email 3 and the GST
 * returns in email 1, because those happen to be the sizes that fit — and a
 * credit manager reading email 1 would raise a query for a certificate that
 * was already sent. So documents are grouped the way a banker reads them, the
 * groups are kept whole where they fit, and only a group too large for one
 * email is split. Size safety wins where the two conflict; nothing else does.
 *
 * DETERMINISM IS A REQUIREMENT, NOT A PROPERTY. The same selection produces
 * the same batches every time, on every machine. Nothing here sorts by an
 * unstable key, reads a clock, or consults a random source: a user who sees
 * "3 emails" on the review screen and presses Send must get the three emails
 * they reviewed.
 */

import {
  MAX_ATTACHMENT_BYTES_PER_EMAIL,
  ineligibility,
  type CandidateDocument,
  type IneligibilityReason,
} from "./attachments.js";

// ---------------------------------------------------------------------------
// How a banker reads a file.
// ---------------------------------------------------------------------------

/**
 * The reading groups, in the order they belong in a file.
 *
 * KYC first because that is what a credit manager opens first, then the
 * business's papers, then its numbers in the order they are argued from, then
 * the security, then what the money is for.
 */
export const ATTACHMENT_GROUPS = [
  "kyc",
  "business_registration",
  "gst",
  "itr",
  "financial_statements",
  "bank_statements",
  "income",
  "property",
  "purpose",
  "additional",
] as const;

export type AttachmentGroup = (typeof ATTACHMENT_GROUPS)[number];

/**
 * How a group names itself when it is the ONLY thing in an email.
 *
 * "Bank Statements" rather than "Bank Statement Documents", because that is
 * what it is called. See `describeGroups` for how several of them combine.
 */
export const ATTACHMENT_GROUP_PHRASE: Record<AttachmentGroup, string> = {
  kyc: "KYC Documents",
  business_registration: "Business Registration Documents",
  gst: "GST Documents",
  itr: "ITR Documents",
  financial_statements: "Financial Statements",
  bank_statements: "Bank Statements",
  income: "Income Documents",
  property: "Property Documents",
  purpose: "Project & Quotation Documents",
  additional: "Additional Documents",
};

/** The noun used when a group appears alongside others: "GST & ITR Documents". */
const ATTACHMENT_GROUP_STEM: Record<AttachmentGroup, string> = {
  kyc: "KYC",
  business_registration: "Business Registration",
  gst: "GST",
  itr: "ITR",
  financial_statements: "Financial Statement",
  bank_statements: "Bank Statement",
  income: "Income",
  property: "Property",
  purpose: "Project & Quotation",
  additional: "Additional",
};

/**
 * How a group reads inside a sentence: "the GST documents", "three years of
 * ITR documents". Lower case, because it is mid-sentence.
 */
const ATTACHMENT_GROUP_PROSE: Record<AttachmentGroup, string> = {
  kyc: "KYC documents",
  business_registration: "business registration documents",
  gst: "GST documents",
  itr: "ITR documents",
  financial_statements: "financial statements",
  bank_statements: "bank statements",
  income: "income documents",
  property: "property documents",
  purpose: "project and quotation documents",
  additional: "additional documents",
};

export function groupProse(group: AttachmentGroup): string {
  return ATTACHMENT_GROUP_PROSE[group];
}

/**
 * Document types whose reading group is not simply their checklist section.
 *
 * Only the exceptions are listed. Everything else falls back to the section
 * the Document Requirement Engine already put it in (ADR-038), which is the
 * right answer far more often than a second hand-maintained map would be —
 * and which means a document type added to the catalogue tomorrow lands
 * somewhere sensible without anyone remembering to edit this file.
 *
 * The exceptions all exist because a bank reads something differently from
 * how a telecaller collects it. The GST certificate is collected with the
 * business's papers and read with the returns. The ITRs are collected under
 * income and personal-vs-business, and read as one run of returns.
 */
const GROUP_BY_DOCUMENT_TYPE: Readonly<Record<string, AttachmentGroup>> = {
  // GST — the certificate proves the registration the returns are filed under.
  gst_certificate: "gst",
  gst_returns: "gst",

  // The returns, personal and business, plus what the tax department itself
  // says. A banker reads these as one run.
  itr: "itr",
  org_itr: "itr",
  form_16: "itr",
  form_26as: "itr",

  // Banking, personal and business.
  bank_statement: "bank_statements",
  org_bank_statement: "bank_statements",

  // The accounts.
  balance_sheet: "financial_statements",
  profit_and_loss: "financial_statements",
  audit_report: "financial_statements",
  stock_statement: "financial_statements",
  debtors_creditors_statement: "financial_statements",

  // What the money is for.
  project_report: "purpose",
  machinery_quotation: "purpose",
  vehicle_quotation: "purpose",
  contract_or_tender: "purpose",
  invoice_bills: "purpose",
  buyer_acceptance: "purpose",
  fee_structure: "purpose",
  admission_letter: "purpose",
};

/** Checklist section → reading group, for everything not named above. */
const GROUP_BY_CATEGORY: Readonly<Record<string, AttachmentGroup>> = {
  kyc: "kyc",
  business_registration: "business_registration",
  business_financials: "financial_statements",
  income: "income",
  property: "property",
  additional: "additional",
};

export function groupOf(document: CandidateDocument): AttachmentGroup {
  return (
    GROUP_BY_DOCUMENT_TYPE[document.documentTypeCode] ??
    GROUP_BY_CATEGORY[document.category] ??
    "additional"
  );
}

// ---------------------------------------------------------------------------
// Ordering.
// ---------------------------------------------------------------------------

/**
 * The order documents are considered in, and therefore the order they appear
 * in the emails.
 *
 * Group first, then document type, then MOST RECENT FINANCIAL YEAR FIRST, then
 * file name. The year direction is the one non-obvious choice and it is
 * deliberate: a banker assessing turnover reads the latest year and works
 * backwards, so "GST 3B – FY 2025-26" belongs above "FY 2023-24" in the
 * attachment list exactly as it does on the checklist.
 *
 * File name is the final tie-break so that two documents identical in every
 * other respect still have one stable order — without it the sort would depend
 * on input order, and input order depends on which checkbox a user clicked
 * first.
 */
export function compareForBatching(a: CandidateDocument, b: CandidateDocument): number {
  const groupDelta =
    ATTACHMENT_GROUPS.indexOf(groupOf(a)) - ATTACHMENT_GROUPS.indexOf(groupOf(b));
  if (groupDelta !== 0) return groupDelta;

  if (a.documentTypeCode !== b.documentTypeCode) {
    return a.documentTypeCode < b.documentTypeCode ? -1 : 1;
  }

  const yearA = a.financialYearLabel ?? "";
  const yearB = b.financialYearLabel ?? "";
  if (yearA !== yearB) return yearA < yearB ? 1 : -1;

  if (a.fileName !== b.fileName) return a.fileName < b.fileName ? -1 : 1;
  return a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The plan.
// ---------------------------------------------------------------------------

export interface AttachmentBatch {
  /** 1-based. The number a subject line says out loud: "(2/3)". */
  readonly sequence: number;
  readonly documents: readonly CandidateDocument[];
  readonly totalBytes: number;
  /** Reading groups present, in `ATTACHMENT_GROUPS` order. Drives the subject. */
  readonly groups: readonly AttachmentGroup[];
}

export type BatchPlanProblem =
  | { readonly kind: "nothing_selected" }
  | {
      readonly kind: "document_not_sendable";
      readonly document: CandidateDocument;
      readonly reason: IneligibilityReason;
    };

export type BatchPlanResult =
  | { readonly ok: true; readonly batches: readonly AttachmentBatch[] }
  | { readonly ok: false; readonly problem: BatchPlanProblem };

export interface BatchOptions {
  readonly limitBytes?: number;
}

/**
 * Split `documents` into the emails they will be sent as.
 *
 * REFUSES RATHER THAN COPES. A document that cannot be sent — unverified,
 * rejected, or larger by itself than one whole email — stops the plan and is
 * named. It is not silently dropped (the file would go to the bank incomplete
 * and nobody would know), not silently compressed (the bank would receive a
 * document the customer never signed), and not silently sent anyway.
 *
 * THE ALGORITHM, in full, because "deterministic and explainable" is a
 * requirement of this milestone and an algorithm nobody can restate is
 * neither:
 *
 *   1. Sort by `compareForBatching`. Collect into reading groups.
 *   2. For each group in order:
 *        a. If the whole group fits in what is left of the current email, put
 *           it there.
 *        b. Otherwise, if the whole group would fit in an empty email, start a
 *           new one and put it there — keeping the group together at the cost
 *           of some space in the email just closed.
 *        c. Otherwise the group is genuinely too big for any one email, so its
 *           documents are laid down in order, starting a new email whenever
 *           the next one does not fit.
 *
 * Step (b) is where "keep related documents together where practical" lives,
 * and step (c) is where "size safety takes precedence" overrules it.
 */
export function planBatches(
  documents: readonly CandidateDocument[],
  options?: BatchOptions,
): BatchPlanResult {
  const limitBytes = options?.limitBytes ?? MAX_ATTACHMENT_BYTES_PER_EMAIL;

  if (documents.length === 0) {
    return { ok: false, problem: { kind: "nothing_selected" } };
  }

  for (const document of documents) {
    const reason = ineligibility(document, limitBytes);
    if (reason) {
      return { ok: false, problem: { kind: "document_not_sendable", document, reason } };
    }
  }

  const ordered = [...documents].sort(compareForBatching);

  // Grouped, preserving the order established above. A Map keeps insertion
  // order, and insertion order here is `ATTACHMENT_GROUPS` order because the
  // sort put it there.
  const grouped = new Map<AttachmentGroup, CandidateDocument[]>();
  for (const document of ordered) {
    const group = groupOf(document);
    const bucket = grouped.get(group);
    if (bucket) bucket.push(document);
    else grouped.set(group, [document]);
  }

  const batches: CandidateDocument[][] = [];
  let current: CandidateDocument[] = [];
  let currentBytes = 0;

  const closeCurrent = (): void => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
  };

  for (const bucket of grouped.values()) {
    const bucketBytes = bucket.reduce((total, document) => total + document.fileSizeBytes, 0);

    if (currentBytes + bucketBytes <= limitBytes) {
      current.push(...bucket);
      currentBytes += bucketBytes;
      continue;
    }

    if (bucketBytes <= limitBytes) {
      closeCurrent();
      current.push(...bucket);
      currentBytes = bucketBytes;
      continue;
    }

    // Too big to keep whole. Lay it down in order and break where it must.
    for (const document of bucket) {
      if (currentBytes + document.fileSizeBytes > limitBytes) {
        closeCurrent();
      }
      current.push(document);
      currentBytes += document.fileSizeBytes;
    }
  }
  closeCurrent();

  return {
    ok: true,
    batches: batches.map((batchDocuments, index) => ({
      sequence: index + 1,
      documents: batchDocuments,
      totalBytes: batchDocuments.reduce((total, document) => total + document.fileSizeBytes, 0),
      groups: groupsIn(batchDocuments),
    })),
  };
}

/** The reading groups present in a batch, in `ATTACHMENT_GROUPS` order. */
export function groupsIn(documents: readonly CandidateDocument[]): readonly AttachmentGroup[] {
  const present = new Set(documents.map(groupOf));
  return ATTACHMENT_GROUPS.filter((group) => present.has(group));
}

/**
 * How the contents of one email name themselves in a subject line.
 *
 *   one group          → its own phrase       "Bank Statements"
 *   two or three       → stems, then Documents "GST & ITR Documents"
 *   four or more       → the first two, then   "KYC, GST & Other Documents"
 *
 * The four-or-more case is a genuine trade-off: a subject naming everything is
 * a subject nobody reads, and one saying "Documents" tells a banker with six
 * files open nothing at all. Naming the two the email leads with is the useful
 * half of both.
 */
export function describeGroups(groups: readonly AttachmentGroup[]): string {
  if (groups.length === 0) return "Documents";
  if (groups.length === 1) return ATTACHMENT_GROUP_PHRASE[groups[0] as AttachmentGroup];

  const stems = groups.map((group) => ATTACHMENT_GROUP_STEM[group]);
  if (groups.length <= 3) {
    return `${joinWithAmpersand(stems)} Documents`;
  }
  return `${joinWithAmpersand([...stems.slice(0, 2), "Other"])} Documents`;
}

/** "A", "A & B", "A, B & C" — how a person writes a list. */
export function joinWithAmpersand(parts: readonly string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(", ")} & ${parts[parts.length - 1] as string}`;
}
