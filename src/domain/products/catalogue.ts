/**
 * The lending product catalogue, as domain logic rather than as a screen.
 *
 * Source of truth: ADR-016, ADR-032, ADR-033. Schema: Database/migrations/0015, 0017.
 *
 * A lending product is the finest-grained thing that is both known at case
 * creation and stable enough to generate requirements from — coarser than a
 * bank's own product (chosen late, ADR-016) and finer than a loan category
 * ("Business Loan" does not tell you whether a property is involved). Every
 * later engine reads this shape, so it lives in src/domain/ where the server
 * and the prototype run the same code, not in the screen that edits it.
 *
 * WHAT THIS MODULE DOES: lifecycle (is this product offerable today?) and
 * selection (which products match what an office user typed or ticked?).
 *
 * WHAT IT DELIBERATELY DOES NOT DO: decide whether a customer is eligible.
 * The eligibility fields on a product are DECLARATIVE — they describe the
 * market the product exists in, not a lender's credit policy. ADR-016's
 * warning is the reason: an out-of-date engine that confidently returns a
 * wrong answer is worse than no engine. `matchesFilter` below narrows a list
 * for a human who is choosing; it never answers "will this be approved?".
 */

/**
 * How strongly a product requires something — the codes seeded into
 * `requirement_applicability` (Database/migrations/0016).
 *
 * Typed as a union of the seeded codes AND `string`, deliberately: the table
 * is master data and a business user may add a fourth value ("mandatory
 * unless waived") without a deploy, which a closed union would make
 * impossible to represent. The named members are what autocomplete offers
 * and what the checks below understand; anything else is treated as "not one
 * of the three I know", never as an error.
 */
export type ApplicabilityCode = "mandatory" | "optional" | "not_applicable" | (string & {});

/**
 * A lending product, as every engine downstream needs to see it.
 *
 * Codes rather than ids throughout: this module is pure and has no database
 * to resolve an id against, and a code is what a requirement template, a
 * report or an AI prompt would name anyway. The layer that loads a product
 * resolves ids to codes once; everything after that reads meaning.
 */
export type AvailabilityStatus = "active" | "temporarily_suspended" | "retired";

export interface LendingProduct {
  readonly code: string;
  readonly name: string;
  readonly customerProductCode?: string | undefined;
  readonly description?: string | undefined;
  readonly securityTypeCode?: string | undefined;
  readonly borrowerTypeCodes?: readonly string[] | undefined;
  readonly employmentTypeCodes?: readonly string[] | undefined;
  readonly businessConstitutionCodes?: readonly string[] | undefined;
  readonly propertyRequirement?: ApplicabilityCode | undefined;
  readonly gstRequirement?: ApplicabilityCode | undefined;
  readonly minTenureMonths?: number | undefined;
  readonly maxTenureMonths?: number | undefined;
  readonly minAmount?: number | undefined;
  readonly maxAmount?: number | undefined;
  readonly isActive: boolean;
  /**
   * Active, Temporarily Suspended or Retired (Database/migrations/0017).
   * Undefined means the loader did not carry it — treated as `"active"` when
   * `isActive` is true and `"retired"` when it is not, so older data and
   * `isActive` alone still produce the right answer (ADR-033).
   */
  readonly availabilityStatus?: AvailabilityStatus | undefined;
  /** ISO date. Null/undefined means "as long as it has been active". */
  readonly effectiveFrom?: string | undefined;
  /** ISO date. The last day the product was offered. */
  readonly effectiveTo?: string | undefined;
  /** The code of the earlier product this one replaces, if it is a revision. */
  readonly supersedesProductCode?: string | undefined;
  /**
   * Who typically takes this product, in office-staff language — "Salaried
   * Employee", "Textile Unit", "NRI". Informational only: NOT an eligibility
   * rule (Database/migrations/0017).
   */
  readonly typicalCustomerProfile?: string | undefined;
  /**
   * A concise, human-readable summary of what is usually asked for.
   * Guidance, not a requirement template — the Document Requirement Engine
   * is a separate, future milestone (Database/migrations/0017).
   */
  readonly typicalDocumentsSummary?: string | undefined;
}

// ---------------------------------------------------------------------------
// Lifecycle — retirement and revision, which the schema supports and no
// screen builds yet (Database/migrations/0015).
// ---------------------------------------------------------------------------

/**
 * Why a product is or is not offerable on a given date.
 *
 * Five states rather than a boolean because the reasons are not
 * interchangeable to the person reading them: a product that has not started
 * yet will start, a retired one will not, and a superseded one has somewhere
 * else to send you.
 */
export type ProductAvailability =
  | "offerable"
  | "not_yet_effective"
  | "expired"
  | "suspended"
  | "retired"
  | "superseded";

/** Compares ISO dates as strings — safe because ISO dates sort lexically. */
function isoDay(value: string): string {
  return value.slice(0, 10);
}

/**
 * Is this product offerable on `on` (an ISO date), and if not, why not?
 *
 * `supersededBy` is passed in rather than looked up: this module holds no
 * catalogue of its own, and the caller already has the list.
 */
export function productAvailability(
  product: LendingProduct,
  on: string,
  supersededByCodes: ReadonlySet<string> = new Set(),
): ProductAvailability {
  const day = isoDay(on);

  if (product.effectiveFrom && isoDay(product.effectiveFrom) > day) {
    return "not_yet_effective";
  }
  if (product.effectiveTo && isoDay(product.effectiveTo) < day) {
    return "expired";
  }
  // Superseded is reported ahead of retired/suspended: all three are
  // inactive, but only one of them can tell the user where the product went.
  if (supersededByCodes.has(product.code)) {
    return "superseded";
  }
  // Undefined status falls back to isActive alone (ADR-033): older or
  // partially-loaded data must still resolve to a sensible answer.
  const status = product.availabilityStatus ?? (product.isActive ? "active" : "retired");
  if (status === "temporarily_suspended") {
    return "suspended";
  }
  if (status === "retired" || !product.isActive) {
    return "retired";
  }
  return "offerable";
}

/** Convenience over `productAvailability` for the common yes/no question. */
export function isOfferable(
  product: LendingProduct,
  on: string,
  supersededByCodes?: ReadonlySet<string>,
): boolean {
  return productAvailability(product, on, supersededByCodes) === "offerable";
}

/**
 * The set of product codes that some other product supersedes.
 *
 * Derived rather than stored on each product, because the arrow in the
 * schema points backwards (a revision names what it replaces) and every
 * reader wants it forwards.
 */
export function supersededCodes(products: readonly LendingProduct[]): ReadonlySet<string> {
  const codes = new Set<string>();
  for (const product of products) {
    if (product.supersedesProductCode) {
      codes.add(product.supersedesProductCode);
    }
  }
  return codes;
}

// ---------------------------------------------------------------------------
// Selection — what a searching, filtering human needs.
// ---------------------------------------------------------------------------

/**
 * A catalogue filter. Every field is optional and absent means "do not
 * narrow on this" — never "match nothing", which is the mistake that makes
 * a filter panel feel broken the moment someone clears a box.
 */
export interface ProductFilter {
  /** Free text, matched against name, code, description and customer product code. */
  readonly query?: string | undefined;
  readonly customerProductCode?: string | undefined;
  readonly securityTypeCode?: string | undefined;
  readonly borrowerTypeCode?: string | undefined;
  readonly employmentTypeCode?: string | undefined;
  readonly businessConstitutionCode?: string | undefined;
  /** True: only products that require a property. False: only those that do not. */
  readonly requiresProperty?: boolean | undefined;
  readonly requiresGst?: boolean | undefined;
  /** Include retired and superseded products. Defaults to false. */
  readonly includeInactive?: boolean | undefined;
  /** The date availability is judged on. Defaults to the caller's today. */
  readonly on?: string | undefined;
}

function matchesText(product: LendingProduct, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    product.name,
    product.code,
    product.description ?? "",
    product.customerProductCode ?? "",
  ]
    .join(" ")
    .toLowerCase();
  // Every word must appear somewhere, in any order: "business unsecured"
  // finds the unsecured business loan, which "business unsecured" as one
  // substring would not.
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

/**
 * Does a multi-valued eligibility list admit `wanted`?
 *
 * An EMPTY list means the product admits nobody on that axis — a salaried
 * personal loan has no business constitutions, and that emptiness is the
 * answer (Database/migrations/0016). An UNDEFINED list means the caller did
 * not load that axis, which must not silently exclude everything, so it
 * admits anything.
 */
function admits(list: readonly string[] | undefined, wanted: string): boolean {
  if (list === undefined) return true;
  return list.includes(wanted);
}

/** True when an applicability code means the thing is genuinely needed. */
export function isRequired(applicability: ApplicabilityCode | undefined): boolean {
  return applicability === "mandatory";
}

/** True when an applicability code rules the thing out entirely. */
export function isNotApplicable(applicability: ApplicabilityCode | undefined): boolean {
  return applicability === "not_applicable";
}

export function matchesFilter(product: LendingProduct, filter: ProductFilter): boolean {
  const on = filter.on ?? new Date().toISOString().slice(0, 10);

  if (!filter.includeInactive && !isOfferable(product, on)) return false;
  if (filter.query !== undefined && !matchesText(product, filter.query)) return false;
  if (
    filter.customerProductCode !== undefined &&
    product.customerProductCode !== filter.customerProductCode
  ) {
    return false;
  }
  if (
    filter.securityTypeCode !== undefined &&
    product.securityTypeCode !== filter.securityTypeCode
  ) {
    return false;
  }
  if (
    filter.borrowerTypeCode !== undefined &&
    !admits(product.borrowerTypeCodes, filter.borrowerTypeCode)
  ) {
    return false;
  }
  if (
    filter.employmentTypeCode !== undefined &&
    !admits(product.employmentTypeCodes, filter.employmentTypeCode)
  ) {
    return false;
  }
  if (
    filter.businessConstitutionCode !== undefined &&
    !admits(product.businessConstitutionCodes, filter.businessConstitutionCode)
  ) {
    return false;
  }
  if (filter.requiresProperty !== undefined) {
    if (isRequired(product.propertyRequirement) !== filter.requiresProperty) return false;
  }
  if (filter.requiresGst !== undefined) {
    if (isRequired(product.gstRequirement) !== filter.requiresGst) return false;
  }
  return true;
}

export function filterProducts(
  products: readonly LendingProduct[],
  filter: ProductFilter,
): LendingProduct[] {
  const superseded = supersededCodes(products);
  const on = filter.on ?? new Date().toISOString().slice(0, 10);
  return products.filter((product) => {
    if (!filter.includeInactive && !isOfferable(product, on, superseded)) return false;
    return matchesFilter(product, { ...filter, includeInactive: true });
  });
}

// ---------------------------------------------------------------------------
// Presentation helpers.
//
// Here rather than in the screen because a tenure range means the same thing
// in the catalogue, on a case, in a report and in an AI summary, and three
// slightly different renderings of it is how a system stops sounding like
// one system.
// ---------------------------------------------------------------------------

/** "5 – 30 years", "12 months", "Up to 7 years", or undefined if unstated. */
export function describeTenure(product: LendingProduct): string | undefined {
  const { minTenureMonths: min, maxTenureMonths: max } = product;
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined) {
    if (min === max) return describeMonths(min);
    return `${describeMonths(min)} – ${describeMonths(max)}`;
  }
  if (max !== undefined) return `Up to ${describeMonths(max)}`;
  return `From ${describeMonths(min as number)}`;
}

function describeMonths(months: number): string {
  if (months % 12 === 0 && months >= 12) {
    const years = months / 12;
    return `${years} ${years === 1 ? "year" : "years"}`;
  }
  return `${months} ${months === 1 ? "month" : "months"}`;
}

/**
 * Indian-notation money: "₹5 L", "₹1.5 Cr", "₹10 K".
 *
 * Lakhs and crores rather than thousands and millions because that is what
 * every person using this system says out loud, and a catalogue that reads
 * "₹10,000,000" makes an office user do arithmetic to check it says one
 * crore.
 */
export function describeAmount(rupees: number): string {
  if (rupees >= 10000000) {
    return `₹${trimZeros(rupees / 10000000)} Cr`;
  }
  if (rupees >= 100000) {
    return `₹${trimZeros(rupees / 100000)} L`;
  }
  if (rupees >= 1000) {
    return `₹${trimZeros(rupees / 1000)} K`;
  }
  return `₹${rupees}`;
}

function trimZeros(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** "₹5 L – ₹1 Cr", "Up to ₹20 L", or undefined if unstated. */
export function describeAmountRange(product: LendingProduct): string | undefined {
  const { minAmount: min, maxAmount: max } = product;
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined) return `${describeAmount(min)} – ${describeAmount(max)}`;
  if (max !== undefined) return `Up to ${describeAmount(max)}`;
  return `From ${describeAmount(min as number)}`;
}
