/**
 * The case screen's four sections, and the order a case is worked in.
 *
 * WHY THIS IS A MODULE AND NOT FOUR STRINGS IN CaseDetail.tsx
 *
 * The order is a workflow, not a layout: Overview establishes the facts,
 * Documents collects against them, Banks sends the file, Timeline records what
 * happened. "Save & continue" means "the next one of these", and a telecaller
 * who is taught that order should never find the buttons disagreeing with the
 * tabs.
 *
 * It also makes the order testable without a browser. The navigation bugs this
 * milestone exists to prevent — landing on the wrong case, losing the tab on a
 * refresh, a bad `?tab=` in a pasted link resetting the screen — are decided
 * entirely by the two functions below, and both are pure.
 *
 * The tab itself lives in the URL (`?tab=`), which is what makes the browser's
 * back button walk back through the sections instead of leaving the case, and
 * what makes "this case's documents" a link somebody can send. Nothing here
 * touches the case id: the id comes from the path and is never rewritten by a
 * tab change, which is why moving between sections cannot load another case.
 */

export const CASE_TABS = ["overview", "documents", "banks", "timeline"] as const;

export type CaseTab = (typeof CASE_TABS)[number];

export const CASE_TAB_LABELS: Record<CaseTab, string> = {
  overview: "Overview",
  documents: "Documents",
  banks: "Banks",
  timeline: "Timeline",
};

/**
 * What each section is for, in one line, shown beside its Save & continue
 * button. A user who has just saved should be told where they are going and
 * why, rather than being moved somewhere and left to work it out.
 */
export const CASE_TAB_PURPOSE: Record<CaseTab, string> = {
  overview: "The facts that decide what this case is asked for.",
  documents: "Collect and verify what those facts require.",
  banks: "Send the file to the lenders it suits.",
  timeline: "Everything that happened, in order.",
};

/**
 * Read a `?tab=` value.
 *
 * An unrecognised or missing value resolves to Overview rather than throwing
 * or rendering nothing — a stale bookmark or a hand-edited URL should open the
 * case, not break it.
 */
export function resolveCaseTab(requested: string | null | undefined): CaseTab {
  return (CASE_TABS as readonly string[]).includes(requested ?? "")
    ? (requested as CaseTab)
    : "overview";
}

/** The section after this one, or undefined at the end of the workflow. */
export function nextCaseTab(tab: CaseTab): CaseTab | undefined {
  return CASE_TABS[CASE_TABS.indexOf(tab) + 1];
}

/** The section before this one, or undefined at the start. */
export function previousCaseTab(tab: CaseTab): CaseTab | undefined {
  const index = CASE_TABS.indexOf(tab);
  return index <= 0 ? undefined : CASE_TABS[index - 1];
}
