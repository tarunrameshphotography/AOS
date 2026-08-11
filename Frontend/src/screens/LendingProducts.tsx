/**
 * The Lending Product Catalogue (Milestone 7, ADR-032; refined in Milestone
 * 7.1, ADR-033).
 *
 * The middle layer of the lending hierarchy, given a screen of its own:
 *
 *   Customer Product   →   Lending Product   →   Bank Product
 *   (Master Data)          (this screen)         (Bank & NBFC Catalogue
 *                                                 milestone — not built yet)
 *
 * Built for office staff, so:
 *
 *  - One search box that searches everything (name, code, description,
 *    category), matching words in any order. Nobody should have to know
 *    which field a word lives in.
 *  - Filters as plain dropdowns of master data, never hardcoded lists. Every
 *    option on this screen comes out of a table someone at Amaze can edit.
 *  - The list shows what a person actually asks about a product — is it
 *    secured, does it need a property, what tenure, what amount — rather
 *    than every column.
 *
 * The filtering itself is NOT implemented here: it goes through
 * `filterProducts` from @domain/products, the same code the server will run.
 * A screen that reimplemented "which products match?" would be a second
 * answer to a question the domain layer already answers.
 *
 * READ-ONLY BY DESIGN (Production Readiness Phase 2, "Admin-screen
 * honesty"). This screen displays `Frontend/src/fake/store.ts` — a
 * per-browser prototype dataset, not the office database — so editing here
 * never reached PostgreSQL, any other PC, or a real case. There used to be
 * an Add/Edit form on this screen; it wrote to localStorage only and has
 * been removed so the screen cannot be mistaken for a real configuration
 * tool (see the Master Roadmap, Phase 2). The Master Roadmap explicitly
 * keeps Products read-only unless a later business decision changes that;
 * real cases already read the authoritative product catalogue from
 * PostgreSQL via `Backend/reference.ts`.
 */

import { useMemo, useState, type ReactNode } from "react";

import {
  describeAmountRange,
  describeTenure,
  filterProducts,
  productAvailability,
  supersededCodes,
  type ProductFilter,
} from "@domain/products/index.js";

import { lendingProductsAsDomain } from "../fake/store.js";
import { useDatabase } from "../fake/useDatabase.js";
import type { Database, Id, LoanProduct, MasterDataRecord } from "../fake/types.js";
import { useSession } from "../session.js";
import { Badge, Card, Empty, Input, NotConnectedBanner, Select } from "../ui/index.js";

export function LendingProducts(): ReactNode {
  const db = useDatabase();
  const session = useSession();

  const [query, setQuery] = useState("");
  const [customerProductId, setCustomerProductId] = useState<Id | "">("");
  const [securityTypeId, setSecurityTypeId] = useState<Id | "">("");
  const [borrowerTypeId, setBorrowerTypeId] = useState<Id | "">("");
  const [employmentTypeId, setEmploymentTypeId] = useState<Id | "">("");
  const [propertyFilter, setPropertyFilter] = useState<"" | "yes" | "no">("");
  const [showRetired, setShowRetired] = useState(false);

  const [expanded, setExpanded] = useState<Id | null>(null);

  // Every hook above runs before the permission gate below, because a hook
  // behind a conditional return is the one React rule this screen could
  // plausibly break.
  const domainProducts = useMemo(() => lendingProductsAsDomain(db), [db]);
  const byCode = useMemo(
    () => new Map(domainProducts.map((product) => [product.code, product])),
    [domainProducts],
  );

  const filter: ProductFilter = {
    query,
    ...(codeOf(db.customerProducts, customerProductId) !== undefined
      ? { customerProductCode: codeOf(db.customerProducts, customerProductId) as string }
      : {}),
    ...(codeOf(db.securityTypes, securityTypeId) !== undefined
      ? { securityTypeCode: codeOf(db.securityTypes, securityTypeId) as string }
      : {}),
    ...(codeOf(db.borrowerTypes, borrowerTypeId) !== undefined
      ? { borrowerTypeCode: codeOf(db.borrowerTypes, borrowerTypeId) as string }
      : {}),
    ...(codeOf(db.employmentTypes, employmentTypeId) !== undefined
      ? { employmentTypeCode: codeOf(db.employmentTypes, employmentTypeId) as string }
      : {}),
    ...(propertyFilter ? { requiresProperty: propertyFilter === "yes" } : {}),
    includeInactive: showRetired,
  };

  const matchedCodes = useMemo(
    () => new Set(filterProducts(domainProducts, filter).map((p) => p.code)),
    // The filter object is rebuilt each render; its fields are the real
    // dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [domainProducts, query, customerProductId, securityTypeId, borrowerTypeId, employmentTypeId, propertyFilter, showRetired],
  );

  const superseded = useMemo(() => supersededCodes(domainProducts), [domainProducts]);

  if (!session.can("master_data.read", "all")) {
    return (
      <Card title="Not permitted">
        <p className="text-sm text-ink-700">
          This user does not hold <code>master_data.read</code>.
        </p>
      </Card>
    );
  }

  const visible = db.loanProducts
    .filter((product) => matchedCodes.has(product.code))
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder);

  const filtersApplied =
    query.trim().length > 0 ||
    customerProductId !== "" ||
    securityTypeId !== "" ||
    borrowerTypeId !== "" ||
    employmentTypeId !== "" ||
    propertyFilter !== "";

  const clearFilters = (): void => {
    setQuery("");
    setCustomerProductId("");
    setSecurityTypeId("");
    setBorrowerTypeId("");
    setEmploymentTypeId("");
    setPropertyFilter("");
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Lending Products</h1>
        <p className="mt-1 text-sm text-ink-500">
          What Amaze lends against, independent of any bank. Read-only reference — see the note
          below.
        </p>
        <NotConnectedBanner />
      </div>

      <Card
        title={`${visible.length} of ${db.loanProducts.length} products`}
        subtitle="Search by name, code or anything in the description. Words can be in any order."
      >
        <div className="space-y-3">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="working capital · unsecured · lease rental · gold"
          />

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <FilterSelect
              label="Customer Product"
              value={customerProductId}
              onChange={setCustomerProductId}
              options={db.customerProducts}
            />
            <FilterSelect
              label="Security"
              value={securityTypeId}
              onChange={setSecurityTypeId}
              options={db.securityTypes}
            />
            <FilterSelect
              label="Borrower"
              value={borrowerTypeId}
              onChange={setBorrowerTypeId}
              options={db.borrowerTypes}
            />
            <FilterSelect
              label="Employment"
              value={employmentTypeId}
              onChange={setEmploymentTypeId}
              options={db.employmentTypes}
            />
            <label className="block">
              <span className="block text-xs font-medium text-ink-700">Property</span>
              <Select
                value={propertyFilter}
                onChange={(event) =>
                  setPropertyFilter(event.target.value as "" | "yes" | "no")
                }
              >
                <option value="">Any</option>
                <option value="yes">Property required</option>
                <option value="no">No property needed</option>
              </Select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-ink-700">
              <input
                type="checkbox"
                checked={showRetired}
                onChange={(event) => setShowRetired(event.target.checked)}
              />
              Show suspended and retired products
            </label>
            {filtersApplied && (
              <button
                onClick={clearFilters}
                className="text-xs font-medium text-brand-700 hover:underline"
              >
                Clear filters
              </button>
            )}
          </div>

          {visible.length === 0 ? (
            <Empty>
              No product matches. Try fewer words, or clear the filters — a retired product is
              hidden unless you ask for it.
            </Empty>
          ) : (
            <ul className="divide-y divide-ink-100">
              {visible.map((product) => {
                const domain = byCode.get(product.code);
                const availability = domain
                  ? productAvailability(domain, today(), superseded)
                  : "offerable";
                return (
                  <li key={product.id} className="py-3 first:pt-0 last:pb-0">
                    <button
                      className="w-full text-left"
                      onClick={() => setExpanded(expanded === product.id ? null : product.id)}
                    >
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {product.name ?? product.variant}
                        <Badge tone="info">
                          {nameOf(db.customerProducts, product.customerProductId) ?? product.category}
                        </Badge>
                        {availability !== "offerable" && (
                          <Badge tone="neutral">{AVAILABILITY_LABELS[availability]}</Badge>
                        )}
                      </p>
                      <p className="tnum mt-0.5 text-xs text-ink-500">
                        {product.code}
                        {domain && describeTenure(domain) && ` · ${describeTenure(domain)}`}
                        {domain && describeAmountRange(domain) && ` · ${describeAmountRange(domain)}`}
                        {product.securityTypeId &&
                          ` · ${nameOf(db.securityTypes, product.securityTypeId)}`}
                      </p>
                    </button>

                    {expanded === product.id && <ProductDetail db={db} product={product} />}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>

      <Card
        title="Where this sits"
        subtitle="Three layers, three different questions. The catalogue models them separately on purpose."
      >
        <ol className="space-y-2 text-sm text-ink-700">
          <li>
            <span className="font-medium">Customer Product</span> — what a telecaller thinks of
            first, e.g. Home Loan or Business Loan. Managed under Master Data.
          </li>
          <li>
            <span className="font-medium">Lending Product</span> — what Amaze actually arranges,
            e.g. Working Capital Facility. This screen. Known at case creation.
          </li>
          <li>
            <span className="font-medium">Bank Product</span> — one lender's version of it, e.g.
            HDFC Smart Business Loan. Chosen late, and so it can never drive document requirements
            (ADR-016). Its own screen is the Bank &amp; NBFC Catalogue milestone.
          </li>
        </ol>
      </Card>
    </div>
  );
}

const AVAILABILITY_LABELS: Record<string, string> = {
  retired: "Retired",
  suspended: "Temporarily Suspended",
  superseded: "Superseded",
  expired: "No longer offered",
  not_yet_effective: "Not yet effective",
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function codeOf(list: readonly MasterDataRecord[], id: Id | ""): string | undefined {
  if (!id) return undefined;
  return list.find((record) => record.id === id)?.code;
}

function nameOf(list: readonly MasterDataRecord[], id?: Id): string | undefined {
  if (!id) return undefined;
  return list.find((record) => record.id === id)?.name;
}

function names(list: readonly MasterDataRecord[], ids?: readonly Id[]): string {
  if (ids === undefined) return "—";
  if (ids.length === 0) return "None";
  return ids
    .map((id) => nameOf(list, id))
    .filter((name): name is string => name !== undefined)
    .join(", ");
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: Id | "";
  onChange: (value: Id | "") => void;
  options: readonly MasterDataRecord[];
}): ReactNode {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-ink-700">{label}</span>
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Any</option>
        {options
          .filter((option) => option.isActive)
          .slice()
          .sort((a, b) => a.displayOrder - b.displayOrder)
          .map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
      </Select>
    </label>
  );
}

/**
 * The whole product, shown on demand rather than crammed into the row.
 * Everything here is a fact about the product; nothing here is a decision
 * about a customer.
 */
function ProductDetail({ db, product }: { db: Database; product: LoanProduct }): ReactNode {
  return (
    <div className="mt-3 rounded-md bg-ink-50 p-3">
      {product.description && <p className="text-sm text-ink-700">{product.description}</p>}
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
        <Detail label="Security">{nameOf(db.securityTypes, product.securityTypeId) ?? "—"}</Detail>
        <Detail label="Borrower types">{names(db.borrowerTypes, product.borrowerTypeIds)}</Detail>
        <Detail label="Property">
          {nameOf(db.requirementApplicabilities, product.propertyRequirementId) ?? "—"}
        </Detail>
        <Detail label="GST registration">
          {nameOf(db.requirementApplicabilities, product.gstRequirementId) ?? "—"}
        </Detail>
        <Detail label="Employment eligibility">
          {names(db.employmentTypes, product.employmentTypeIds)}
        </Detail>
        <Detail label="Business eligibility">
          {names(db.businessConstitutions, product.businessConstitutionIds)}
        </Detail>
      </dl>
      {(product.typicalCustomerProfile ?? product.typicalDocumentsSummary) && (
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
          {product.typicalCustomerProfile && (
            <Detail label="Typical customer profile">{product.typicalCustomerProfile}</Detail>
          )}
          {product.typicalDocumentsSummary && (
            <Detail label="Usually requested">{product.typicalDocumentsSummary}</Detail>
          )}
        </dl>
      )}
      <p className="mt-3 text-xs text-ink-500">
        Tenure and amount ranges, typical customer profile and usually-requested documents are all
        guidance, never a rule. The binding figures are per lender and live on that lender's own
        product (ADR-016); exact document requirements are the Document Requirement Engine
        milestone, not yet built.
      </p>
      {product.notes && <p className="mt-2 text-xs text-ink-500">{product.notes}</p>}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div>
      <dt className="font-medium text-ink-700">{label}</dt>
      <dd className="text-ink-500">{children}</dd>
    </div>
  );
}
