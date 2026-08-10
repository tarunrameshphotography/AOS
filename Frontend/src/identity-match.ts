/**
 * "Do we already know this person?", as one rule.
 *
 * Extracted in Stage 3B. The rule was inside `lib.ts`'s `personCandidates`,
 * reading the prototype store's `Person` objects. Customers now come from the
 * API in a different shape, and the new-case picker needed the same
 * judgement — so rather than write a second version of it against the new
 * shape, the judgement moved here and both callers pass a minimal subject.
 *
 * It is a UI heuristic and nothing more: it decides what to WARN about, never
 * what to merge. A missed duplicate is a permanent data wound; a false warning
 * costs two seconds (PRD/Identity Resolution.md Part 2).
 *
 * THE ONE RULE WORTH KNOWING: a phone match alone is never Definite. In India
 * a family shares one handset and a disconnected number is reissued to a
 * stranger, so treating a phone hit as identity is exactly how one person's
 * history ends up attached to another's (ADR-013).
 */

export type MatchTier = "definite" | "probable" | "possible";

/** The least a candidate must expose to be judged. Both the API's customer
 * shape and the prototype's `Person` can produce one. */
export interface MatchSubject {
  readonly fullName: string;
  readonly aliases: readonly string[];
  /** Every phone on file, raw. Normalised here, so callers need not. */
  readonly phones: readonly string[];
}

/** How many digits of a phone number are worth matching on. Four is what
 * somebody actually remembers and types. */
const MIN_PHONE_DIGITS = 4;

/** Below this a name fragment matches half the database and warns about
 * nothing useful. */
const MIN_NAME_CHARS = 3;

/**
 * How strongly `subject` looks like the person being typed, or null for "not
 * a candidate at all".
 */
export function matchTier(
  subject: MatchSubject,
  typedName: string,
  typedPhone: string,
): MatchTier | null {
  const digits = typedPhone.replace(/\D/g, "");
  const needle = typedName.trim().toLowerCase();

  const phoneHit =
    digits.length >= MIN_PHONE_DIGITS &&
    subject.phones.some((phone) => phone.replace(/\D/g, "").includes(digits));

  const nameHit =
    needle.length >= MIN_NAME_CHARS &&
    [subject.fullName, ...subject.aliases].some((value) =>
      value.toLowerCase().includes(needle),
    );

  if (!phoneHit && !nameHit) return null;
  // Name AND number is the only combination confident enough to call definite.
  if (phoneHit && nameHit) return "definite";
  return phoneHit ? "probable" : "possible";
}

/** Whether there is enough typed to bother searching at all. */
export function worthSearching(typedName: string, typedPhone: string): boolean {
  return (
    typedPhone.replace(/\D/g, "").length >= MIN_PHONE_DIGITS ||
    typedName.trim().length >= MIN_NAME_CHARS
  );
}
