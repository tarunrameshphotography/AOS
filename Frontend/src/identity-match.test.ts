/**
 * The duplicate-match rule.
 *
 * Extracted in Stage 3B so the API-backed picker on the new-case screen and
 * the prototype picker cannot drift apart. It is worth its own tests because
 * it is the judgement behind the one moment the product visibly beats memory —
 * and because the rule that a phone match alone is never Definite is the kind
 * of thing a well-meaning simplification would delete.
 */

import { describe, expect, it } from "vitest";

import { matchTier, worthSearching, type MatchSubject } from "./identity-match.js";

const ravi: MatchSubject = {
  fullName: "Ravi Kumar",
  aliases: ["Ravikumar", "Ravi K"],
  phones: ["98430 12345"],
};

describe("matchTier", () => {
  it("calls a name and number together definite", () => {
    expect(matchTier(ravi, "Ravi", "9843012345")).toBe("definite");
  });

  it("never calls a phone match alone definite", () => {
    // The family-phone and recycled-number case. Assuming identity from a
    // number is how one person's history ends up attached to another's
    // (ADR-013) — so this is `probable`, never `definite`.
    expect(matchTier(ravi, "", "9843012345")).toBe("probable");
    expect(matchTier(ravi, "Someone Else", "9843012345")).toBe("probable");
  });

  it("calls a name match alone possible", () => {
    expect(matchTier(ravi, "Ravi", "")).toBe("possible");
  });

  it("matches an alias, because the wrong spelling is what gets typed next time", () => {
    // Transliterated Tamil names have no single correct spelling.
    expect(matchTier(ravi, "Ravikumar", "")).toBe("possible");
  });

  it("matches a phone by a fragment and ignores its formatting", () => {
    // Four digits is what somebody actually remembers, and the stored value
    // has a space in it.
    expect(matchTier(ravi, "", "2345")).toBe("probable");
    expect(matchTier(ravi, "", "98430-12345")).toBe("probable");
  });

  it("returns null when nothing matches", () => {
    expect(matchTier(ravi, "Lakshmi", "9000000000")).toBeNull();
  });

  it("ignores fragments too short to mean anything", () => {
    // Two letters or three digits match half the database and warn about
    // nothing useful.
    expect(matchTier(ravi, "Ra", "")).toBeNull();
    expect(matchTier(ravi, "", "234")).toBeNull();
  });

  it("is case-insensitive on names", () => {
    expect(matchTier(ravi, "RAVI KUMAR", "")).toBe("possible");
  });

  it("handles a person with no phones on file", () => {
    const noPhone: MatchSubject = { fullName: "Silent Customer", aliases: [], phones: [] };
    expect(matchTier(noPhone, "Silent", "9843012345")).toBe("possible");
  });
});

describe("worthSearching", () => {
  it("waits for enough to go on", () => {
    expect(worthSearching("", "")).toBe(false);
    expect(worthSearching("Ra", "123")).toBe(false);
  });

  it("searches on either a name fragment or four digits", () => {
    expect(worthSearching("Rav", "")).toBe(true);
    expect(worthSearching("", "2345")).toBe(true);
  });
});
