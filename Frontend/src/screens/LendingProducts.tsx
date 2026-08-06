/**
 * The Lending Product Catalogue (Milestone 7, ADR-032).
 *
 * The middle layer of the lending hierarchy, given a screen of its own:
 *
 *   Loan Category   →   Lending Product   →   Bank Product
 *   (Master Data)       (this screen)         (Bank & NBFC Catalogue
 *                                              milestone — not built yet)
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
 *  - Editing is one form with the fields grouped the way the questions come.
 *
 * The filtering itself is NOT implemented here: it goes through
 * `filterProducts` from @domain/products, the same code the server will run.
 * A screen that reimplemented "which products match?" would be a second
 * answer to a question the domain layer already answers.
 *
 * Deliberately absent, per the milestone brief: eligibility decisions ("will
 * this customer qualify?"), bank-specific products, product revisions and
 * retirement workflows, document requirement templates. The schema supports
 * every one of them (Database/migrations/0015); none is built here.
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

import {
  createLendingProduct,
  lendingProductsAsDomain,
  setLendingProductActive,
  updateLendingProduct,
  type LendingProductInput,
} from "../fake/store.js";
import { useDatabase } from "../fake/useDatabase.js";
import type { Database, Id, LoanProduct, MasterDataRecord } from "../fake/types.js";
import { useSession } from "../session.js";
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
  useToast,
} from "../ui/index.js";

export function LendingProducts(): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const toast = useToast();

  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState<Id | "">("");
  const [securityTypeId, setSecurityTypeId] = useState<Id | "">("");
  const [borrowerTypeId, setBorrowerTypeId] = useState<Id | "">("");
  const [employmentTypeId, setEmploymentTypeId] = useState<Id | "">("");
  const [propertyFilter, setPropertyFilter] = useState<"" | "yes" | "no">("");
  const [showRetired, setShowRetired] = useState(false);

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<LoanProduct | null>(null);
  const [expanded, setExpanded] = useState<Id | null>(null);

  const canManage = session.can("master_data.manage", "all");

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
    ...(codeOf(db.loanCategories, categoryId) !== undefined
      ? { categoryCode: codeOf(db.loanCategories, categoryId) as string }
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
    [domainProducts, query, categoryId, securityTypeId, borrowerTypeId, employmentTypeId, propertyFilter, showRetired],
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
    categoryId !== "" ||
    securityTypeId !== "" ||
    borrowerTypeId !== "" ||
    employmentTypeId !== "" ||
    propertyFilter !== "";

  const clearFilters = (): void => {
    setQuery("");
    setCategoryId("");
    setSecurityTypeId("");
    setBorrowerTypeId("");
    setEmploymentTypeId("");
    setPropertyFilter("");
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Lending Products</h1>
        <p className="mt-1 text-sm text-ink-500">
          What Amaze lends against, independent of any bank. A product here is chosen when a case
          is created — before a bank is picked — which is what lets AOS know from day one which
          documents the file will need.
          {!canManage && " This user can view but not edit — hold master_data.manage to change products."}
        </p>
      </div>

      <Card
        title={`${visible.length} of ${db.loanProducts.length} products`}
        subtitle="Search by name, code or anything in the description. Words can be in any order."
        actions={
          canManage && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add product
            </Button>
          )
        }
      >
        <div className="space-y-3">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="working capital · unsecured · lease rental · gold"
          />

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <FilterSelect
              label="Category"
              value={categoryId}
              onChange={setCategoryId}
              options={db.loanCategories}
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
              Show retired products
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
                    <div className="flex items-start gap-3">
                      <button
                        className="min-w-0 flex-1 text-left"
                        onClick={() => setExpanded(expanded === product.id ? null : product.id)}
                      >
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {product.name ?? product.variant}
                          <Badge tone="info">
                            {nameOf(db.loanCategories, product.loanCategoryId) ?? product.category}
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
                      {canManage && (
                        <div className="flex shrink-0 items-center gap-2">
                          <Button onClick={() => setEditing(product)}>Edit</Button>
                          <Button
                            variant={product.isActive ? "secondary" : "primary"}
                            onClick={() => {
                              const result = setLendingProductActive(
                                product.id,
                                !product.isActive,
                                session.user.id,
                              );
                              toast.show(
                                result.ok
                                  ? `${product.name ?? product.variant} ${
                                      product.isActive ? "retired" : "reactivated"
                                    }.`
                                  : (result.message ?? "Could not update."),
                                result.ok ? "good" : "bad",
                              );
                            }}
                          >
                            {product.isActive ? "Retire" : "Reactivate"}
                          </Button>
                        </div>
                      )}
                    </div>

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
            <span className="font-medium">Loan Category</span> — Amaze's commercial grouping, e.g.
            Business Loans. Managed under Master Data.
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

      {adding && (
        <ProductForm
          title="Add lending product"
          db={db}
          onClose={() => setAdding(false)}
          onSubmit={(input) => {
            const result = createLendingProduct(input, session.user.id);
            if (result.ok) setAdding(false);
            toast.show(
              result.ok ? `${input.name} added.` : (result.message ?? "Could not add."),
              result.ok ? "good" : "bad",
            );
          }}
        />
      )}

      {editing && (
        <ProductForm
          title="Edit lending product"
          db={db}
          initial={editing}
          onClose={() => setEditing(null)}
          onSubmit={(input) => {
            const result = updateLendingProduct(editing.id, input, session.user.id);
            if (result.ok) setEditing(null);
            toast.show(
              result.ok ? `${input.name} updated.` : (result.message ?? "Could not update."),
              result.ok ? "good" : "bad",
            );
          }}
        />
      )}
    </div>
  );
}

const AVAILABILITY_LABELS: Record<string, string> = {
  retired: "Retired",
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
      <p className="mt-3 text-xs text-ink-500">
        Tenure and amount ranges are typical of the market, not a commitment. The binding figures
        are per lender and live on that lender's own product (ADR-016).
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

// ---------------------------------------------------------------------------
// The form.
//
// Grouped the way the questions come — what is it, what secures it, who can
// take it, how big and how long — rather than in schema order. Nothing on it
// is a free-text vocabulary field: every choice is master data.
// ---------------------------------------------------------------------------

function ProductForm({
  title,
  db,
  initial,
  onClose,
  onSubmit,
}: {
  title: string;
  db: Database;
  initial?: LoanProduct;
  onClose: () => void;
  onSubmit: (input: LendingProductInput) => void;
}): ReactNode {
  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? initial?.variant ?? "");
  const [loanCategoryId, setLoanCategoryId] = useState(initial?.loanCategoryId ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [securityTypeId, setSecurityTypeId] = useState(initial?.securityTypeId ?? "");
  const [propertyRequirementId, setPropertyRequirementId] = useState(
    initial?.propertyRequirementId ?? "",
  );
  const [gstRequirementId, setGstRequirementId] = useState(initial?.gstRequirementId ?? "");
  const [borrowerTypeIds, setBorrowerTypeIds] = useState<Id[]>(initial?.borrowerTypeIds ?? []);
  const [employmentTypeIds, setEmploymentTypeIds] = useState<Id[]>(
    initial?.employmentTypeIds ?? [],
  );
  const [businessConstitutionIds, setBusinessConstitutionIds] = useState<Id[]>(
    initial?.businessConstitutionIds ?? [],
  );
  const [minTenure, setMinTenure] = useState(String(initial?.minTenureMonths ?? ""));
  const [maxTenure, setMaxTenure] = useState(String(initial?.maxTenureMonths ?? ""));
  const [minAmount, setMinAmount] = useState(String(initial?.minAmount ?? ""));
  const [maxAmount, setMaxAmount] = useState(String(initial?.maxAmount ?? ""));
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const ready = code.trim().length > 0 && name.trim().length > 0 && loanCategoryId !== "";
  const numeric = (value: string): number | undefined =>
    value.trim() === "" ? undefined : Number(value);

  return (
    <Modal open title={title} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Product name" hint="What office staff call it.">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Lease Rental Discounting"
            />
          </Field>
          <Field label="Code" hint="Internal, stable, lowercase_with_underscores.">
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={initial !== undefined}
              placeholder="e.g. lap_lrd"
            />
          </Field>
        </div>

        <Field label="Loan category" hint="The commercial grouping. Managed under Master Data.">
          <Select
            value={loanCategoryId}
            onChange={(event) => setLoanCategoryId(event.target.value)}
          >
            <option value="">— Choose —</option>
            {activeSorted(db.loanCategories).map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Description" hint="One or two sentences. Explains the product to a new joiner.">
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Security">
            <Select
              value={securityTypeId}
              onChange={(event) => setSecurityTypeId(event.target.value)}
            >
              <option value="">— None chosen —</option>
              {activeSorted(db.securityTypes).map((security) => (
                <option key={security.id} value={security.id}>
                  {security.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Property required?">
            <Select
              value={propertyRequirementId}
              onChange={(event) => setPropertyRequirementId(event.target.value)}
            >
              <option value="">— Not stated —</option>
              {activeSorted(db.requirementApplicabilities).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="GST registration?">
            <Select
              value={gstRequirementId}
              onChange={(event) => setGstRequirementId(event.target.value)}
            >
              <option value="">— Not stated —</option>
              {activeSorted(db.requirementApplicabilities).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <CheckboxGroup
          label="Borrower types"
          hint="Who can take this product."
          options={activeSorted(db.borrowerTypes)}
          selected={borrowerTypeIds}
          onChange={setBorrowerTypeIds}
        />
        <CheckboxGroup
          label="Employment eligibility"
          hint="Which income profiles this product exists for."
          options={activeSorted(db.employmentTypes)}
          selected={employmentTypeIds}
          onChange={setEmploymentTypeIds}
        />
        <CheckboxGroup
          label="Business eligibility"
          hint="Which constitutions of firm can borrow. Leave empty for a product no firm takes."
          options={activeSorted(db.businessConstitutions)}
          selected={businessConstitutionIds}
          onChange={setBusinessConstitutionIds}
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tenure, months" hint="Typical market range. Guidance, never a rule.">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                value={minTenure}
                onChange={(event) => setMinTenure(event.target.value)}
                placeholder="Min"
              />
              <span className="text-xs text-ink-500">to</span>
              <Input
                type="number"
                value={maxTenure}
                onChange={(event) => setMaxTenure(event.target.value)}
                placeholder="Max"
              />
            </div>
          </Field>
          <Field label="Loan amount, rupees" hint="Typical market range across lenders.">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                value={minAmount}
                onChange={(event) => setMinAmount(event.target.value)}
                placeholder="Min"
              />
              <span className="text-xs text-ink-500">to</span>
              <Input
                type="number"
                value={maxAmount}
                onChange={(event) => setMaxAmount(event.target.value)}
                placeholder="Max"
              />
            </div>
          </Field>
        </div>

        <Field label="Notes" hint="Free text for office staff. Not read by any business rule.">
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() =>
              onSubmit({
                code,
                name,
                loanCategoryId,
                ...(description ? { description } : {}),
                ...(securityTypeId ? { securityTypeId } : {}),
                ...(propertyRequirementId ? { propertyRequirementId } : {}),
                ...(gstRequirementId ? { gstRequirementId } : {}),
                borrowerTypeIds,
                employmentTypeIds,
                businessConstitutionIds,
                ...(numeric(minTenure) !== undefined
                  ? { minTenureMonths: numeric(minTenure) as number }
                  : {}),
                ...(numeric(maxTenure) !== undefined
                  ? { maxTenureMonths: numeric(maxTenure) as number }
                  : {}),
                ...(numeric(minAmount) !== undefined
                  ? { minAmount: numeric(minAmount) as number }
                  : {}),
                ...(numeric(maxAmount) !== undefined
                  ? { maxAmount: numeric(maxAmount) as number }
                  : {}),
                ...(notes ? { notes } : {}),
              })
            }
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function activeSorted(list: readonly MasterDataRecord[]): MasterDataRecord[] {
  return list
    .filter((record) => record.isActive)
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder);
}

/**
 * Tick boxes rather than a multi-select list box: a multi-select needs a
 * modifier key nobody teaches, and eligibility is exactly the field an
 * office user gets half-right and then cannot see what they picked.
 */
function CheckboxGroup({
  label,
  hint,
  options,
  selected,
  onChange,
}: {
  label: string;
  hint: string;
  options: readonly MasterDataRecord[];
  selected: readonly Id[];
  onChange: (value: Id[]) => void;
}): ReactNode {
  return (
    <div>
      <p className="text-xs font-medium text-ink-700">{label}</p>
      <p className="text-xs text-ink-500">{hint}</p>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
        {options.map((option) => {
          const checked = selected.includes(option.id);
          return (
            <label key={option.id} className="flex items-center gap-1.5 text-sm text-ink-700">
              <input
                type="checkbox"
                checked={checked}
                onChange={() =>
                  onChange(
                    checked
                      ? selected.filter((id) => id !== option.id)
                      : [...selected, option.id],
                  )
                }
              />
              {option.name}
            </label>
          );
        })}
      </div>
    </div>
  );
}
