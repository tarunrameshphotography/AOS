/**
 * The lender catalogue, as domain logic rather than as a screen.
 *
 * Source of truth: ADR-014, ADR-015, ADR-016, ADR-034. Schema:
 * Database/migrations/0019, 0020.
 *
 * AOS's lender intelligence layer. Not a list of banks — a model of how
 * Amaze works with lending institutions, with the five concepts the domain
 * genuinely has kept apart:
 *
 *   Institution → Branch → Relationship Manager
 *        ↘ Supported Products    (which lending products it does)
 *        ↘ Submission Rules      (how a file is lodged — reference only)
 *        ↘ Profile Insights      (what the team has learned — guidance only)
 *
 * WHAT THIS MODULE DOES: selection (which lenders match what an office user
 * typed or ticked), reachability (is this lender, or this branch, usable
 * today), and presentation of the few things that must read identically
 * everywhere.
 *
 * WHAT IT DELIBERATELY DOES NOT DO — each of these is a named later
 * milestone, and each would be easy to start here and wrong to:
 *
 *   Route a case. `filterLenders` narrows a list FOR A HUMAN who is
 *   choosing. It does not rank, score or recommend, and nothing in it knows
 *   anything about a case.
 *
 *   Decide eligibility. The business-intelligence fields are prose written
 *   by staff for staff. ADR-016's warning stands: a confident wrong answer
 *   is worse than none.
 *
 *   Interpret an insight. `LenderInsight.body` is never parsed, matched or
 *   branched on anywhere in this module, and must not be. It is grouped by
 *   its category and handed to a person. An assistant may quote it as
 *   something the team observed; it may never present it as a condition it
 *   checked. That line is the reason insights are a separate type from the
 *   fields beside them (ADR-034).
 */

// ---------------------------------------------------------------------------
// Shapes.
//
// Codes rather than ids throughout, matching @domain/products: this module is
// pure and has no database to resolve an id against, and a code is what a
// report, a routing rule or an AI prompt would name anyway. The layer that
// loads a lender resolves ids to codes once.
// ---------------------------------------------------------------------------

/**
 * How a branch is doing today — the codes on
 * `bank_branch.operational_status` (Database/migrations/0019).
 *
 * Three states rather than a boolean, and for the reason ADR-033 gave for
 * products: "closed for renovation until March" and "this branch is gone"
 * are not the same fact to the person deciding where to lodge a file next
 * week.
 */
export type BranchStatus = "operational" | "temporarily_closed" | "closed";

/** A lending institution — a bank, an NBFC or a housing finance company. */
export interface LenderInstitution {
  readonly code: string;
  readonly name: string;
  /** The master-data lender type code: `public_sector_bank`, `nbfc`, … */
  readonly lenderTypeCode?: string | undefined;
  readonly headOfficeCity?: string | undefined;
  /** Free text, as staff say it: "Tamil Nadu and Kerala", "Pan-India". */
  readonly primaryServiceRegion?: string | undefined;
  readonly websiteUrl?: string | undefined;
  /**
   * Does Amaze currently work with this lender? Distinct from `isActive`,
   * which is whether the institution exists at all — Lakshmi Vilas Bank is
   * inactive because it no longer exists, and a lender Amaze has stopped
   * using is off-panel but very much alive.
   */
  readonly isOnPanel: boolean;
  readonly isActive: boolean;
  /** Calendar days, as the office observes it. Informational, never an SLA. */
  readonly typicalTurnaroundDays?: number | undefined;
  readonly preferredCustomerSegments?: string | undefined;
  readonly knownStrengths?: string | undefined;
  readonly knownLimitations?: string | undefined;
  readonly commonRejectionPatterns?: string | undefined;
  readonly internalRemarks?: string | undefined;
  readonly notes?: string | undefined;
  /** Alternative names — "SBI", "Chola", "LIC HFL". Searched, never displayed. */
  readonly aliases?: readonly string[] | undefined;
}

/** One institution's branch. */
export interface LenderBranch {
  readonly id: string;
  readonly institutionCode: string;
  readonly name: string;
  readonly cityCode?: string | undefined;
  readonly districtCode?: string | undefined;
  readonly addressLine?: string | undefined;
  readonly contactNumber?: string | undefined;
  readonly email?: string | undefined;
  readonly status: BranchStatus;
  readonly isActive: boolean;
  readonly notes?: string | undefined;
}

/** A person at a lender, as Amaze deals with them. */
export interface RelationshipManager {
  readonly id: string;
  readonly personName: string;
  readonly institutionCode: string;
  /** Absent for a regional or state-level manager who belongs to no branch. */
  readonly branchId?: string | undefined;
  /** The master-data role code. */
  readonly roleCode?: string | undefined;
  /** The lender's own job title, verbatim (ADR-028's two-layer pattern). */
  readonly designation?: string | undefined;
  readonly workMobile?: string | undefined;
  readonly workEmail?: string | undefined;
  readonly notes?: string | undefined;
  readonly isActive: boolean;
}

/**
 * That a lender offers a lending product. NOT a redefinition of the product
 * — the definition lives in @domain/products and this only names it
 * (Database/migrations/0019, Part 5).
 */
export interface SupportedProduct {
  readonly id: string;
  /** The institution, or one of its branches when that branch differs. */
  readonly organisationCode: string;
  readonly lendingProductCode: string;
  /** The lender's own name for it, where it has one. */
  readonly name?: string | undefined;
  readonly minAmount?: number | undefined;
  readonly maxAmount?: number | undefined;
  readonly indicativeRate?: number | undefined;
  readonly notes?: string | undefined;
  readonly isActive: boolean;
}

/**
 * How a file is lodged with a lender. REFERENCE MATERIAL — read by a person,
 * executed by nothing. See the warning on `lender_submission_rule`.
 */
export interface SubmissionRule {
  readonly id: string;
  readonly organisationCode: string;
  /** Absent means the rule covers every product this lender does. */
  readonly lendingProductCode?: string | undefined;
  readonly submissionModeCode?: string | undefined;
  readonly portalUrl?: string | undefined;
  readonly whatToCarry?: string | undefined;
  readonly loginFeeNotes?: string | undefined;
  readonly turnaroundNotes?: string | undefined;
  readonly notes?: string | undefined;
  readonly isActive: boolean;
}

/**
 * A piece of institutional knowledge about working with a lender.
 *
 * "Excellent for textile businesses." "Often asks for an extra year of ITR."
 * "The RM prefers WhatsApp before email."
 *
 * GUIDANCE, NEVER A RULE. `body` is not parsed by anything in this module
 * and must not be parsed by anything downstream. It is filed under a
 * category, dated, and shown to a human — or, later, quoted to an assistant
 * as something the team observed. The distinction between what Amaze has
 * learned and what a lender has stated is the entire reason this type exists
 * separately from the fields on {@link LenderInstitution} (ADR-034).
 */
export interface LenderInsight {
  readonly id: string;
  readonly organisationCode: string;
  readonly categoryCode: string;
  readonly body: string;
  /** Optional narrowing to one lending product. */
  readonly lendingProductCode?: string | undefined;
  /** ISO date. When this was true — experience ages, and a reader who can
   * see the date can discount it. */
  readonly observedOn?: string | undefined;
  readonly isActive: boolean;
}

// ---------------------------------------------------------------------------
// Reachability — can we use this lender, or this branch, today?
// ---------------------------------------------------------------------------

/**
 * Why an institution is or is not usable right now.
 *
 * Three states rather than a boolean because the reasons are not
 * interchangeable to the person reading them: `off_panel` is a decision
 * Amaze made and can reverse this afternoon; `inactive` usually means the
 * lender has merged or ceased and never comes back.
 */
export type LenderAvailability = "available" | "off_panel" | "inactive";

export function lenderAvailability(institution: LenderInstitution): LenderAvailability {
  if (!institution.isActive) return "inactive";
  if (!institution.isOnPanel) return "off_panel";
  return "available";
}

/** Convenience over {@link lenderAvailability} for the common yes/no question. */
export function isAvailable(institution: LenderInstitution): boolean {
  return lenderAvailability(institution) === "available";
}

/**
 * Can a file physically be lodged at this branch today?
 *
 * Deliberately strict about `temporarily_closed`: a branch that is shut this
 * month cannot take a file this month, whatever it will do in March. The
 * three-state detail is preserved on the branch itself for the person
 * reading it.
 */
export function isLodgeable(branch: LenderBranch): boolean {
  return branch.isActive && branch.status === "operational";
}

// ---------------------------------------------------------------------------
// Selection — what a searching, filtering office user needs.
// ---------------------------------------------------------------------------

/**
 * A catalogue filter. Every field is optional and absent means "do not
 * narrow on this" — never "match nothing", which is the mistake that makes a
 * filter panel feel broken the moment somebody clears a box.
 */
export interface LenderFilter {
  /** Free text, matched against name, code, aliases, region and head office. */
  readonly query?: string | undefined;
  readonly lenderTypeCode?: string | undefined;
  /** Only lenders with a branch in this district. */
  readonly districtCode?: string | undefined;
  /** Only lenders with a branch in this city. */
  readonly cityCode?: string | undefined;
  /** Only lenders that support this lending product. */
  readonly lendingProductCode?: string | undefined;
  /** True: only lenders Amaze currently works with. Defaults to false. */
  readonly onPanelOnly?: boolean | undefined;
  /** Include lenders that no longer exist. Defaults to false. */
  readonly includeInactive?: boolean | undefined;
}

/**
 * Everything hanging off the institutions, passed alongside them.
 *
 * Passed in rather than looked up because this module holds no catalogue of
 * its own — the same stance @domain/products takes with `supersededBy`. The
 * caller already has these lists.
 */
export interface LenderContext {
  readonly branches?: readonly LenderBranch[] | undefined;
  readonly supportedProducts?: readonly SupportedProduct[] | undefined;
}

function matchesText(institution: LenderInstitution, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    institution.name,
    institution.code,
    institution.lenderTypeCode ?? "",
    institution.headOfficeCity ?? "",
    institution.primaryServiceRegion ?? "",
    ...(institution.aliases ?? []),
  ]
    .join(" ")
    .toLowerCase();
  // Every word must appear somewhere, in any order — "chola chennai" finds
  // Cholamandalam, which one substring would not. Same rule as the lending
  // product catalogue, so search behaves identically on both screens.
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

/**
 * The branches of one institution, in the order a person would read them:
 * the ones you can lodge at first.
 */
export function branchesOf(
  institution: LenderInstitution,
  branches: readonly LenderBranch[],
): LenderBranch[] {
  return branches
    .filter((branch) => branch.institutionCode === institution.code)
    .slice()
    .sort((a, b) => {
      const lodgeable = Number(isLodgeable(b)) - Number(isLodgeable(a));
      return lodgeable !== 0 ? lodgeable : a.name.localeCompare(b.name);
    });
}

/**
 * Every lending product code this institution supports, counting products
 * recorded against the institution AND against any of its branches.
 *
 * Both are meaningful (Database/migrations/0019, Part 5): most lenders offer
 * a product everywhere and record it once at the institution, while a branch
 * row is for the case where one branch genuinely differs. A caller asking
 * "does this lender do LAP?" wants yes for either.
 */
export function supportedProductCodes(
  institution: LenderInstitution,
  context: LenderContext,
): ReadonlySet<string> {
  const products = context.supportedProducts ?? [];
  const branchIds = new Set(
    (context.branches ?? [])
      .filter((branch) => branch.institutionCode === institution.code)
      .map((branch) => branch.id),
  );
  const codes = new Set<string>();
  for (const product of products) {
    if (!product.isActive) continue;
    if (product.organisationCode === institution.code || branchIds.has(product.organisationCode)) {
      codes.add(product.lendingProductCode);
    }
  }
  return codes;
}

export function matchesFilter(
  institution: LenderInstitution,
  filter: LenderFilter,
  context: LenderContext = {},
): boolean {
  if (!filter.includeInactive && !institution.isActive) return false;
  if (filter.onPanelOnly && !institution.isOnPanel) return false;
  if (filter.query !== undefined && !matchesText(institution, filter.query)) return false;
  if (
    filter.lenderTypeCode !== undefined &&
    institution.lenderTypeCode !== filter.lenderTypeCode
  ) {
    return false;
  }

  if (filter.districtCode !== undefined || filter.cityCode !== undefined) {
    const own = (context.branches ?? []).filter(
      (branch) => branch.institutionCode === institution.code && branch.isActive,
    );
    if (
      filter.districtCode !== undefined &&
      !own.some((branch) => branch.districtCode === filter.districtCode)
    ) {
      return false;
    }
    if (
      filter.cityCode !== undefined &&
      !own.some((branch) => branch.cityCode === filter.cityCode)
    ) {
      return false;
    }
  }

  if (filter.lendingProductCode !== undefined) {
    if (!supportedProductCodes(institution, context).has(filter.lendingProductCode)) {
      return false;
    }
  }

  return true;
}

export function filterLenders(
  institutions: readonly LenderInstitution[],
  filter: LenderFilter,
  context: LenderContext = {},
): LenderInstitution[] {
  return institutions.filter((institution) => matchesFilter(institution, filter, context));
}

// ---------------------------------------------------------------------------
// The lender profile — grouped, never interpreted.
// ---------------------------------------------------------------------------

/** One category's worth of insights, kept together for display. */
export interface InsightGroup {
  readonly categoryCode: string;
  readonly insights: readonly LenderInsight[];
}

/**
 * The insights for one organisation, grouped by category, newest observation
 * first within each group.
 *
 * Grouping is the only processing this module ever does to an insight. It
 * does not summarise, rank, score or extract, because every one of those
 * would be a step towards treating experience as a rule (ADR-034).
 *
 * `organisationCodes` rather than one code: a branch's insights and its
 * institution's insights are both relevant when you are looking at that
 * branch, and the caller decides which to include.
 */
export function insightsFor(
  organisationCodes: readonly string[],
  insights: readonly LenderInsight[],
  categoryOrder: readonly string[] = [],
): InsightGroup[] {
  const wanted = new Set(organisationCodes);
  const relevant = insights.filter(
    (insight) => insight.isActive && wanted.has(insight.organisationCode),
  );

  const byCategory = new Map<string, LenderInsight[]>();
  for (const insight of relevant) {
    const bucket = byCategory.get(insight.categoryCode);
    if (bucket) bucket.push(insight);
    else byCategory.set(insight.categoryCode, [insight]);
  }

  const rank = (code: string): number => {
    const index = categoryOrder.indexOf(code);
    // Unknown categories sort last rather than first: a category somebody
    // added this morning should not displace the ones the team reads daily.
    return index === -1 ? categoryOrder.length : index;
  };

  return [...byCategory.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([categoryCode, list]) => ({
      categoryCode,
      insights: list
        .slice()
        .sort((x, y) => (y.observedOn ?? "").localeCompare(x.observedOn ?? "")),
    }));
}

/**
 * The submission rules that apply when lodging `lendingProductCode` with
 * `organisationCodes`, most specific first.
 *
 * A rule naming the product beats a rule that names none, and a rule against
 * the branch beats one against the institution — which is how a person reads
 * their own notes, and is the extent of the "logic" a reference table is
 * allowed to have. Nothing is filtered out: a general rule still applies
 * when a specific one exists, it just reads second.
 */
export function submissionRulesFor(
  organisationCodes: readonly string[],
  rules: readonly SubmissionRule[],
  lendingProductCode?: string,
): SubmissionRule[] {
  const wanted = new Set(organisationCodes);
  // Later in the caller's list is more specific — the caller passes
  // institution first, then branch.
  const specificity = new Map(organisationCodes.map((code, index) => [code, index]));

  return rules
    .filter((rule) => rule.isActive && wanted.has(rule.organisationCode))
    .filter(
      (rule) =>
        rule.lendingProductCode === undefined ||
        lendingProductCode === undefined ||
        rule.lendingProductCode === lendingProductCode,
    )
    .slice()
    .sort((a, b) => {
      const named = Number(b.lendingProductCode !== undefined) -
        Number(a.lendingProductCode !== undefined);
      if (named !== 0) return named;
      return (
        (specificity.get(b.organisationCode) ?? 0) - (specificity.get(a.organisationCode) ?? 0)
      );
    });
}

// ---------------------------------------------------------------------------
// Presentation helpers.
//
// Here rather than in the screen because a turnaround means the same thing in
// the catalogue, on a case, in a report and in an AI summary, and three
// slightly different renderings of it is how a system stops sounding like one
// system (the same argument @domain/products makes).
// ---------------------------------------------------------------------------

/** "About 7 days", "About 1 day", or undefined if the office has not said. */
export function describeTurnaround(days: number | undefined): string | undefined {
  if (days === undefined) return undefined;
  if (days <= 0) return undefined;
  return `About ${days} ${days === 1 ? "day" : "days"}`;
}

/** "3 branches", "1 branch", "No branches recorded". */
export function describeBranchCount(count: number): string {
  if (count === 0) return "No branches recorded";
  return `${count} ${count === 1 ? "branch" : "branches"}`;
}

/**
 * A one-line summary of an institution for a list row, in office language.
 * Never includes an insight — those carry their category and must not be
 * flattened into a sentence that loses it.
 */
export function describeInstitution(
  institution: LenderInstitution,
  lenderTypeName?: string,
): string {
  const parts = [
    lenderTypeName ?? institution.lenderTypeCode,
    institution.primaryServiceRegion,
    describeTurnaround(institution.typicalTurnaroundDays),
  ].filter((part): part is string => part !== undefined && part !== "");
  return parts.join(" · ");
}
