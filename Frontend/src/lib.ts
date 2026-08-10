/** Lookups and formatting shared across screens. */

import type { Database, Id, LoanCase, Organisation, Person, SubmissionStatus } from "./fake/types.js";
import type { ProgressSummary } from "@domain/requirements/progress.js";
import { matchTier, worthSearching } from "./identity-match.js";

export function money(amount?: number): string {
  if (amount === undefined) return "—";
  // Indian grouping: 35,00,000 rather than 3,500,000. Getting this wrong is the
  // first thing anyone in Madurai would notice.
  return `₹${amount.toLocaleString("en-IN")}`;
}

export function lakhs(amount?: number): string {
  if (amount === undefined) return "—";
  if (amount >= 10000000) return `₹${(amount / 10000000).toFixed(2)} Cr`;
  if (amount >= 100000) return `₹${(amount / 100000).toFixed(1)} L`;
  return money(amount);
}

export function bytes(size: number): string {
  if (size >= 1048576) return `${(size / 1048576).toFixed(1)} MB`;
  return `${Math.round(size / 1024)} KB`;
}

export function when(iso?: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const days = Math.round((Date.now() - date.getTime()) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 0 && days < 30) return `${days} days ago`;
  if (days < 0 && days > -30) return `in ${Math.abs(days)} days`;
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function exactly(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Case-shaped lookups
// ---------------------------------------------------------------------------

/**
 * The primary applicant. Every case has exactly one, at all times (BR-010), so
 * a case that cannot answer this is a bug rather than an empty state.
 */
export function primaryApplicant(db: Database, caseId: Id): Person | undefined {
  const party = db.caseParties.find(
    (p) => p.caseId === caseId && p.isPrimary && !p.removedAt,
  );
  return db.people.find((person) => person.id === party?.personId);
}

export function partyName(db: Database, partyId?: Id): string {
  const party = db.caseParties.find((p) => p.id === partyId);
  if (!party) return "The case";
  const person = db.people.find((p) => p.id === party.personId);
  const organisation = db.organisations.find((o) => o.id === party.organisationId);
  return person?.fullName ?? organisation?.canonicalName ?? "Party";
}

/**
 * "Home Loan · Home Loan — Purchase".
 *
 * Prefers the product's own `name` and its customer product (Milestone 7,
 * Database/migrations/0015; renamed from loan category in Milestone 7.1,
 * ADR-033), falling back to the legacy (category, variant) text pair for any
 * row created before the catalogue existed. Both are kept populated, so the
 * fallback is belt-and-braces rather than a live path.
 */
export function productLabel(db: Database, loanCase: LoanCase): string {
  const product = db.loanProducts.find((p) => p.id === loanCase.loanProductId);
  if (!product) return "—";
  const customerProduct =
    db.customerProducts.find((c) => c.id === product.customerProductId)?.name ?? product.category;
  return `${customerProduct} · ${product.name ?? product.variant}`;
}

export function ownerName(db: Database, loanCase: LoanCase): string {
  return db.users.find((u) => u.id === loanCase.ownerUserId)?.name ?? "Unassigned";
}

/**
 * Who first brought this case in — distinct from `ownerName`, which is who
 * currently holds it (real-world-issues milestone, Part 4).
 *
 * `createdByUserId` is undefined on the handful of cases seeded before this
 * field existed; for those, the case's own `case.created` event names the
 * actor, and if even that is missing the current owner is the only honest
 * answer left.
 */
export function originatorName(db: Database, loanCase: LoanCase): string {
  const originatorId =
    loanCase.createdByUserId ??
    db.events.find((e) => e.caseId === loanCase.id && e.eventType === "case.created")
      ?.actorUserId ??
    loanCase.ownerUserId;
  return db.users.find((u) => u.id === originatorId)?.name ?? "Unknown";
}

/**
 * How long the case has been in its current stage — the most recent
 * `case.stage_changed` event's timestamp, or the case's own creation if it
 * has never moved. Purely derived from the existing event log (Part 4);
 * nothing new is stored for this.
 */
export function enteredCurrentStageAt(db: Database, loanCase: LoanCase): string {
  const lastStageChange = db.events
    .filter((e) => e.caseId === loanCase.id && e.eventType === "case.stage_changed")
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
  return lastStageChange?.occurredAt ?? loanCase.createdAt;
}

export interface WaitingOn {
  /** Ready-to-render "Waiting on: ..." line. */
  readonly summary: string;
}

/**
 * Who needs to act next — distinct from `ownerName` (who currently holds the
 * case) and `originatorName` (who brought it in). "Currently with" answers
 * whose desk the case sits on; this answers whose *turn* it is, which is not
 * always the same person once a document has moved into someone else's queue
 * (Workflow Polish milestone, audit finding 13.2).
 *
 * Deliberately derived only from numbers `summariseProgress` already
 * computes plus the case's stage and its submissions — no parallel ownership
 * field, no new stored state. Returns null wherever attribution would be a
 * guess (terminal stages, or a stage with nothing yet to attribute to
 * anyone); the caller shows nothing rather than a wrong or invented answer.
 *
 * A role is named ("Telecaller", "Login Desk") rather than a specific person
 * unless the case's current owner actually holds that role — naming someone
 * who does not do that job would be worse than not naming anyone.
 */
export function waitingOn(
  db: Database,
  loanCase: LoanCase,
  progress: Pick<ProgressSummary, "rejectedCount" | "receivedCount" | "outstandingCount">,
  submissions: readonly { status: SubmissionStatus }[],
): WaitingOn | null {
  if (loanCase.stage === "closed" || loanCase.stage === "lost") return null;

  const owner = db.users.find((u) => u.id === loanCase.ownerUserId);
  const telecallerActor = owner?.roles.includes("telecaller") ? owner.name : "Telecaller";
  const loginDeskActor = owner?.roles.includes("login_executive") ? owner.name : "Login Desk";

  if (
    loanCase.stage === "new" ||
    loanCase.stage === "contacted" ||
    loanCase.stage === "appointment_fixed"
  ) {
    return { summary: `Waiting on: ${telecallerActor} — make contact and move this case forward` };
  }

  if (loanCase.stage === "documents_pending") {
    if (progress.rejectedCount > 0) {
      const n = progress.rejectedCount;
      return {
        summary: `Waiting on: ${telecallerActor} — ${n} document${n === 1 ? "" : "s"} rejected, needs the customer to send a replacement`,
      };
    }
    if (progress.receivedCount > 0) {
      const n = progress.receivedCount;
      return {
        summary: `Waiting on: ${loginDeskActor} — ${n} document${n === 1 ? "" : "s"} awaiting verification`,
      };
    }
    if (progress.outstandingCount > 0) {
      return { summary: `Waiting on: ${telecallerActor} — documents still to collect from the customer` };
    }
    // Nothing outstanding: the case is between "everything verified" and the
    // stage catching up to reflect it. Nobody is meaningfully blocking it.
    return null;
  }

  if (loanCase.stage === "ready_for_submission") {
    const active = submissions.filter((s) => s.status !== "withdrawn" && s.status !== "rejected");
    const notYetSubmitted = active.filter((s) => s.status === "not_submitted");
    if (active.length === 0 || notYetSubmitted.length > 0) {
      return { summary: `Waiting on: ${loginDeskActor} — send this file to a bank` };
    }
    return null;
  }

  if (loanCase.stage === "submitted") {
    if (submissions.some((s) => s.status === "query_raised")) {
      return { summary: `Waiting on: ${loginDeskActor} — a bank has raised a query on this file` };
    }
    // Genuinely the lender's turn from here — AOS has no reliable "who at the
    // bank" to name, so this names the counterparty rather than a colleague.
    return { summary: "Waiting on: the bank — a decision is pending" };
  }

  return null;
}

export function primaryPhone(person?: Person): string | undefined {
  return person?.identifiers.find((i) => i.type === "phone" && i.isPrimary)?.value;
}

/**
 * PAN, masked. The prototype has no masked views, so this stands in for what
 * ADR-026 does in the database: everyone sees the shape, only
 * `identifier.view_full` sees the value.
 */
export function maskedPan(person?: Person): string | undefined {
  const pan = person?.identifiers.find((i) => i.type === "pan")?.value;
  if (!pan) return undefined;
  return `${pan.slice(0, 3)}xxxxx${pan.slice(-1)}`;
}

export function panOf(person?: Person): string | undefined {
  return person?.identifiers.find((i) => i.type === "pan")?.value;
}

/**
 * Cases a person is a party on, in any role — which is what makes recognition
 * possible: "3 previous cases, KYC on file" (Principle #5).
 */
export function casesForPerson(db: Database, personId: Id): LoanCase[] {
  const caseIds = new Set(
    db.caseParties.filter((p) => p.personId === personId && !p.removedAt).map((p) => p.caseId),
  );
  return db.cases.filter((c) => caseIds.has(c.id));
}

/** Verified documents already on file for a person — the repeat-customer win. */
export function verifiedDocumentsFor(db: Database, personId: Id): number {
  return db.documents.filter((d) => d.personId === personId && d.verifiedAt).length;
}

// ---------------------------------------------------------------------------
// Search — one box, mixed results (PRD/Identity Resolution.md Part 7)
// ---------------------------------------------------------------------------

export interface SearchHit {
  kind: "case" | "person" | "organisation" | "property";
  id: Id;
  title: string;
  subtitle: string;
  matchedOn: string;
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Deliberately forgiving. People search with a fragment, a misspelling, a
 * locality, or four digits of a phone number, and every one of those must work —
 * it is the product's central promise, not a nice-to-have.
 */
export function search(db: Database, query: string): SearchHit[] {
  const raw = query.trim();
  if (raw.length < 2) return [];

  const needle = normalise(raw);
  const terms = raw.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: SearchHit[] = [];

  const matches = (haystack: string | undefined): boolean =>
    haystack !== undefined && normalise(haystack).includes(needle);

  for (const person of db.people) {
    const alias = person.aliases.find((a) => matches(a));
    const identifier = person.identifiers.find((i) => matches(i.value));

    let matchedOn: string | null = null;
    if (matches(person.fullName)) matchedOn = "Name";
    else if (alias) matchedOn = `Also known as "${alias}"`;
    else if (identifier) matchedOn = titleCase(identifier.type);
    else if (matches(person.locality)) matchedOn = `Locality — ${person.locality}`;

    if (matchedOn) {
      const cases = casesForPerson(db, person.id);
      hits.push({
        kind: "person",
        id: person.id,
        title: person.fullName,
        subtitle:
          cases.length > 0
            ? `${cases.length} case${cases.length === 1 ? "" : "s"} · ${person.locality ?? "—"}`
            : (person.locality ?? "No cases yet"),
        matchedOn,
      });
    }
  }

  for (const loanCase of db.cases) {
    const applicant = primaryApplicant(db, loanCase.id);
    const properties = db.caseProperties
      .filter((cp) => cp.caseId === loanCase.id)
      .map((cp) => db.properties.find((p) => p.id === cp.propertyId));
    // Both what the branch is called NOW and what the submission recorded at
    // the time (ADR-036). Searching only the live name loses a case lodged
    // with a bank that has since been renamed or merged; searching only the
    // snapshot loses one whose branch was renamed for a good reason and whose
    // new name is the one the user knows. Both are how somebody might ask.
    const banks = db.submissions
      .filter((s) => s.caseId === loanCase.id)
      .flatMap((s) => [
        db.organisations.find((o) => o.id === s.branchOrganisationId)?.canonicalName,
        s.branchNameAtSubmission,
        s.bankNameAtSubmission,
      ])
      .filter((name): name is string => name !== undefined);

    let matchedOn: string | null = null;
    if (matches(loanCase.caseNumber)) matchedOn = "Case number";
    else if (matches(applicant?.fullName)) matchedOn = `Applicant — ${applicant?.fullName}`;
    else if (properties.some((p) => matches(p?.locality) || matches(p?.buildingName)))
      matchedOn = `Property — ${properties[0]?.locality ?? properties[0]?.buildingName}`;
    else if (banks.some((name) => matches(name)))
      matchedOn = `Bank — ${banks.find((name) => matches(name))}`;
    else if (matches(productLabel(db, loanCase))) matchedOn = "Loan type";
    else if (loanCase.tags.some((t) => matches(t))) matchedOn = "Tag";
    else if (terms.length > 1 && terms.every((term) =>
      normalise(
        `${loanCase.caseNumber} ${applicant?.fullName ?? ""} ${productLabel(db, loanCase)} ${properties.map((p) => p?.locality ?? "").join(" ")}`,
      ).includes(normalise(term)),
    ))
      // "ravi anna nagar" — several weak terms that together identify one case.
      matchedOn = "Several terms";

    if (matchedOn) {
      hits.push({
        kind: "case",
        id: loanCase.id,
        title: `${loanCase.caseNumber} · ${applicant?.fullName ?? "No applicant"}`,
        subtitle: `${productLabel(db, loanCase)} · ${titleCase(loanCase.stage)}`,
        matchedOn,
      });
    }
  }

  for (const organisation of db.organisations) {
    if (matches(organisation.canonicalName)) {
      const employed = db.employments.filter(
        (e) => e.organisationId === organisation.id,
      ).length;
      hits.push({
        kind: "organisation",
        id: organisation.id,
        title: organisation.canonicalName,
        subtitle: organisation.roles.map(titleCase).join(", ") +
          (employed > 0 ? ` · ${employed} employed here` : ""),
        matchedOn: "Name",
      });
    }
  }

  for (const property of db.properties) {
    if (matches(property.locality) || matches(property.buildingName)) {
      hits.push({
        kind: "property",
        id: property.id,
        title: [property.buildingName, property.doorNumber].filter(Boolean).join(" ") || "Property",
        subtitle: `${property.locality ?? ""}, ${property.city ?? ""}`,
        matchedOn: matches(property.locality) ? "Locality" : "Building",
      });
    }
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Search-first candidates for person and organisation pickers
//
// The workflow every person- or organisation-attaching screen must follow
// (Product Principle #3, Identity Resolution Parts 2 and 4): type, search
// existing records, rank likely matches, create immediately if nothing
// matches. A dropdown listing every person or every organisation on file is
// the exact failure this exists to remove.
// ---------------------------------------------------------------------------

export interface PersonCandidate {
  person: Person;
  tier: "definite" | "probable" | "possible";
}

/**
 * Candidates from the prototype store.
 *
 * The judgement itself lives in `identity-match.ts` as of Stage 3B, so the
 * API-backed picker on the new-case screen and this one cannot drift apart —
 * a phone match alone is never Definite, and that has to be true in both.
 */
export function personCandidates(db: Database, name: string, phone: string): PersonCandidate[] {
  if (!worthSearching(name, phone)) return [];

  return db.people
    .map((person) => {
      const tier = matchTier(
        {
          fullName: person.fullName,
          aliases: person.aliases,
          phones: person.identifiers
            .filter((identifier) => identifier.type === "phone")
            .map((identifier) => identifier.value),
        },
        name,
        phone,
      );
      return tier === null ? null : { person, tier };
    })
    .filter((entry): entry is PersonCandidate => entry !== null)
    .slice(0, 4);
}

/** Legal suffixes stripped before comparison, so "ABC Textiles" and "ABC
 * Textiles Pvt Ltd" collide as intended (Identity Resolution Part 4). */
const ORG_SUFFIXES = /\b(private limited|pvt\.?\s*ltd\.?|ltd\.?|limited|&\s*co\.?|and co\.?|enterprises|traders)\b/gi;

export function normaliseOrgName(value: string): string {
  return value.toLowerCase().replace(ORG_SUFFIXES, "").replace(/[^a-z0-9]/g, "").trim();
}

export interface OrganisationCandidate {
  organisation: Organisation;
  tier: "definite" | "possible";
}

/**
 * Near-matches surface as suggestions; they are never auto-merged. "Sri
 * Lakshmi Traders" and "Sri Lakshmi Textiles" are plausibly different
 * businesses, and only a human knows (Identity Resolution Part 4).
 */
export function organisationCandidates(db: Database, name: string): OrganisationCandidate[] {
  const needle = normaliseOrgName(name);
  if (needle.length < 3) return [];

  return db.organisations
    .map((organisation) => {
      const hit =
        normaliseOrgName(organisation.canonicalName).includes(needle) ||
        organisation.aliases.some((alias) => normaliseOrgName(alias).includes(needle));
      if (!hit) return null;
      const tier: OrganisationCandidate["tier"] =
        normaliseOrgName(organisation.canonicalName) === needle ? "definite" : "possible";
      return { organisation, tier };
    })
    .filter((entry): entry is OrganisationCandidate => entry !== null)
    .slice(0, 4);
}
