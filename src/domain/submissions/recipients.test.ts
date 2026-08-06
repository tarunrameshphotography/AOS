/**
 * The recipient rules, tested at the boundaries that actually bite.
 *
 * These are not arithmetic checks. Every case here is a mistake somebody
 * makes while adding a bank to a real file at four in the afternoon: pasting
 * a list with a trailing comma, adding the same manager twice from two
 * different branches, typing a name into the email box, marking two people
 * primary because both feel important.
 */

import { describe, expect, it } from "vitest";

import {
  describeCounterparty,
  describeProblem,
  describeRecipient,
  describeRecipientCount,
  isEmailShaped,
  normaliseEmail,
  primaryRecipient,
  validateRecipients,
  type RecipientDraft,
} from "./index.js";

const ok = (drafts: readonly RecipientDraft[]) => {
  const result = validateRecipients(drafts);
  if (!result.ok) throw new Error(`expected valid, got ${result.problem.kind}`);
  return result.recipients;
};

describe("email normalisation", () => {
  it("trims and lower-cases, because a mail server does", () => {
    expect(normaliseEmail("  Manager@Bank.COM ")).toBe("manager@bank.com");
  });

  it("accepts the addresses a bank actually uses", () => {
    for (const email of [
      "suresh.k@indianbank.co.in",
      "homeloans.cbe@hdfcbank.com",
      "rm_rspuram@kvb.co.in",
      "branch-1234@sbi.co.in",
    ]) {
      expect(isEmailShaped(email), `${email} was rejected`).toBe(true);
    }
  });

  it("rejects the mistakes that actually happen", () => {
    for (const email of [
      "Suresh Kumar",           // a name typed into the email box
      "suresh@bank",            // no dot in the domain
      "suresh.k@bank.com,",     // a comma left on from a pasted list
      "a@b.com b@c.com",        // two addresses in one field
      "@bank.com",
      "",
    ]) {
      expect(isEmailShaped(email), `${email} was accepted`).toBe(false);
    }
  });
});

describe("validating the bankers a file is addressed to", () => {
  it("refuses a submission with nobody to send it to", () => {
    const result = validateRecipients([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.kind).toBe("none_given");
  });

  // Blank rows are what an "+ Add Banker" button produces when somebody
  // clicks it once more than they needed. They are not an error.
  it("ignores empty rows left behind by the add button", () => {
    const recipients = ok([
      { email: "rm@bank.com" },
      { email: "   " },
      { email: "" },
    ]);
    expect(recipients).toHaveLength(1);
  });

  it("refuses the same address twice, however it was capitalised", () => {
    const result = validateRecipients([
      { email: "rm@bank.com" },
      { email: "RM@Bank.com" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.kind).toBe("duplicate");
  });

  it("refuses a malformed address rather than storing it", () => {
    const result = validateRecipients([{ email: "rm@bank.com" }, { email: "Suresh" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.kind).toBe("malformed");
      if (result.problem.kind === "malformed") expect(result.problem.email).toBe("Suresh");
    }
  });

  it("refuses two primaries", () => {
    const result = validateRecipients([
      { email: "a@bank.com", isPrimary: true },
      { email: "b@bank.com", isPrimary: true },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.kind).toBe("multiple_primaries");
  });

  // The user typed it first because it is the one that matters. Leaving the
  // submission with no primary would only be resolved by guessing later.
  it("makes the first banker primary when nobody said", () => {
    const recipients = ok([{ email: "first@bank.com" }, { email: "second@bank.com" }]);
    expect(recipients[0]?.isPrimary).toBe(true);
    expect(recipients[1]?.isPrimary).toBe(false);
    expect(primaryRecipient(recipients)?.email).toBe("first@bank.com");
  });

  it("honours an explicitly marked primary anywhere in the list", () => {
    const recipients = ok([
      { email: "mailbox@bank.com", kind: "cc" },
      { email: "manager@bank.com", isPrimary: true },
    ]);
    expect(primaryRecipient(recipients)?.email).toBe("manager@bank.com");
    expect(recipients[0]?.isPrimary).toBe(false);
  });

  // Re-sorting would silently overrule somebody who put the manager first on
  // purpose.
  it("preserves the order they were entered in", () => {
    const recipients = ok([
      { email: "c@bank.com" },
      { email: "a@bank.com" },
      { email: "b@bank.com" },
    ]);
    expect(recipients.map((r) => r.email)).toEqual([
      "c@bank.com",
      "a@bank.com",
      "b@bank.com",
    ]);
    expect(recipients.map((r) => r.displayOrder)).toEqual([10, 20, 30]);
  });

  it("keeps a name and designation when given, and does not invent one when not", () => {
    const recipients = ok([
      { email: "rm@bank.com", name: "  Suresh K  ", designation: " Branch Manager " },
      { email: "homeloans@bank.com", name: "   " },
    ]);
    expect(recipients[0]?.name).toBe("Suresh K");
    expect(recipients[0]?.designation).toBe("Branch Manager");
    expect(recipients[1]?.name).toBeUndefined();
  });

  it("defaults an unstated recipient to `to`, never to copied", () => {
    expect(ok([{ email: "rm@bank.com" }])[0]?.kind).toBe("to");
    expect(ok([{ email: "rm@bank.com", kind: "cc" }])[0]?.kind).toBe("cc");
  });

  it("carries the catalogue contact through when there was one", () => {
    const recipients = ok([{ email: "rm@bank.com", bankContactId: "bct-1" }]);
    expect(recipients[0]?.bankContactId).toBe("bct-1");
    // And leaves it absent for an address typed in on the spot, which must
    // stay possible or people keep a second list outside the system.
    expect(ok([{ email: "typed@bank.com" }])[0]?.bankContactId).toBeUndefined();
  });
});

describe("how a submission's counterparty reads", () => {
  const snapshot = {
    bankName: "Indian Bank",
    branchName: "Indian Bank — RS Puram",
    branchCity: "Coimbatore",
    takenAt: "2026-08-06T09:00:00.000Z",
  };

  it("does not repeat the bank name when the branch already carries it", () => {
    expect(describeCounterparty(snapshot)).toBe("Indian Bank — RS Puram");
  });

  it("joins them when the branch is named on its own", () => {
    expect(describeCounterparty({ ...snapshot, branchName: "RS Puram" })).toBe(
      "Indian Bank — RS Puram",
    );
  });

  it("counts bankers in words a person would use", () => {
    expect(describeRecipientCount(0)).toBe("Nobody addressed");
    expect(describeRecipientCount(1)).toBe("1 banker");
    expect(describeRecipientCount(3)).toBe("3 bankers");
  });

  it("writes a recipient the way it would go on an envelope", () => {
    const [named, desk] = ok([
      { email: "suresh.k@bank.com", name: "Suresh K", designation: "Branch Manager" },
      { email: "homeloans.cbe@bank.com" },
    ]);
    expect(describeRecipient(named!)).toBe("Suresh K (Branch Manager) — suresh.k@bank.com");
    // A shared mailbox has no name and that is complete, not partial.
    expect(describeRecipient(desk!)).toBe("homeloans.cbe@bank.com");
  });

  it("has a sentence ready for every problem it can report", () => {
    for (const problem of [
      { kind: "none_given" },
      { kind: "malformed", email: "x" },
      { kind: "duplicate", email: "x@y.com" },
      { kind: "multiple_primaries" },
    ] as const) {
      expect(describeProblem(problem).length).toBeGreaterThan(10);
    }
  });
});
