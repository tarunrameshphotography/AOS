import { describe, expect, it } from "vitest";

import {
  CASE_TABS,
  CASE_TAB_LABELS,
  CASE_TAB_PURPOSE,
  nextCaseTab,
  previousCaseTab,
  resolveCaseTab,
  type CaseTab,
} from "./case-tabs.js";

/**
 * Case navigation (Part 4).
 *
 * The bugs this guards against are the ones a user reports as "it forgot my
 * case": a section that resets the screen, a Save & continue that goes
 * somewhere other than the tab beside it, a pasted link that opens nothing.
 * All of them are decided here, and none of them need a browser to test.
 */
describe("the case workflow's order", () => {
  it("is Overview → Documents → Banks → Timeline", () => {
    expect(CASE_TABS).toEqual(["overview", "documents", "banks", "timeline"]);
  });

  it("walks forward through exactly that order and then stops", () => {
    expect(nextCaseTab("overview")).toBe("documents");
    expect(nextCaseTab("documents")).toBe("banks");
    expect(nextCaseTab("banks")).toBe("timeline");
    // The end of the workflow offers no "continue", rather than looping back
    // to the Overview and looking like the case restarted.
    expect(nextCaseTab("timeline")).toBeUndefined();
  });

  it("walks back through the same order", () => {
    expect(previousCaseTab("timeline")).toBe("banks");
    expect(previousCaseTab("banks")).toBe("documents");
    expect(previousCaseTab("documents")).toBe("overview");
    expect(previousCaseTab("overview")).toBeUndefined();
  });

  it("is a round trip: forward then back returns to where you were", () => {
    for (const tab of CASE_TABS) {
      const forward = nextCaseTab(tab);
      if (forward) expect(previousCaseTab(forward)).toBe(tab);
    }
  });

  it("names and explains every section, so no tab can be added without words for it", () => {
    for (const tab of CASE_TABS) {
      expect(CASE_TAB_LABELS[tab].length).toBeGreaterThan(0);
      expect(CASE_TAB_PURPOSE[tab].length).toBeGreaterThan(0);
    }
  });
});

describe("resolving ?tab= from the URL", () => {
  it("returns the requested section when it is one AOS has", () => {
    for (const tab of CASE_TABS) {
      expect(resolveCaseTab(tab)).toBe(tab);
    }
  });

  it("opens the Overview for a missing, empty or unrecognised value", () => {
    // A stale bookmark, a hand-edited URL or a link from an older build must
    // open the case rather than break it.
    const nonsense: Array<string | null | undefined> = [null, undefined, "", "  ", "Documents", "offers"];
    for (const value of nonsense) {
      expect(resolveCaseTab(value)).toBe("overview");
    }
  });

  it("never resolves to anything outside the four sections", () => {
    const resolved: CaseTab[] = ["overview", "documents", "banks", "timeline", "nope", null].map(
      (value) => resolveCaseTab(value as string | null),
    );
    for (const tab of resolved) {
      expect(CASE_TABS).toContain(tab);
    }
  });
});
