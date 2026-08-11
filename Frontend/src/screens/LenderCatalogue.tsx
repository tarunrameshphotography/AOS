/**
 * The Lender Catalogue (Milestone 8, ADR-034).
 *
 * Not a list of banks — the office's working knowledge of who Amaze lends
 * through, in one place. Five things kept apart on the screen because they are
 * five different things in the schema:
 *
 *   Lender  →  Branch  →  Contact
 *      ↘ Products it does   (points at the Lending Products screen)
 *      ↘ How to submit      (reference notes, nothing executes them)
 *      ↘ What we know       (the lender profile — guidance, never a rule)
 *
 * Built for office staff, so:
 *
 *  - One search box that searches everything — name, short name, region, head
 *    office. Nobody should have to know which field a word lives in.
 *  - Filters as plain dropdowns of master data, never hardcoded lists. Every
 *    option on this screen comes out of a table someone at Amaze can edit,
 *    including the list of lender types.
 *  - The vocabulary is the office's. "Do we work with them?" not "panel
 *    status". "What we know" not "unstructured qualitative attributes".
 *
 * The filtering itself is NOT implemented here: it goes through
 * `filterLenders` from @domain/lenders, the same code the server will run.
 *
 * READ-ONLY BY DESIGN (Production Readiness Phase 2, "Admin-screen
 * honesty"). This screen still displays `Frontend/src/fake/store.ts` — a
 * per-browser prototype dataset, not the office database — so it never
 * offered a real way to maintain the catalogue: an "Add lender" or "Edit
 * branch" control here would have written to localStorage only, invisible to
 * every other PC and to every real case. Maintaining the catalogue for real
 * is `Backend/lenders.ts` + a write route, not yet built, and deliberately
 * out of this phase's scope (see the Master Roadmap, Phase 2). Real lenders
 * are read from Postgres by the Banks tab via `Backend/lenders.ts`
 * (`GET /lenders`) — this screen is reference browsing over the prototype
 * seed data only, clearly labelled as such below.
 *
 * Deliberately absent, per the milestone brief: case routing, eligibility
 * suggestions, submission workflow, turnaround analytics, AI recommendations.
 * The schema supports every one of them (Database/migrations/0019); none is
 * built here. What the screen does instead is collect the facts each of them
 * will need — which is the whole milestone.
 */

import { useMemo, useState, type ReactNode } from "react";

import {
  branchesOf,
  describeBranchCount,
  describeTurnaround,
  filterLenders,
  insightsFor,
  lenderAvailability,
  submissionRulesFor,
  supportedProductCodes,
  type LenderFilter,
  type LenderInstitution,
} from "@domain/lenders/index.js";

import { contactLabel, lendersAsDomain } from "../fake/store.js";
import { useDatabase } from "../fake/useDatabase.js";
import type {
  BankBranch,
  BankContact,
  BranchStatus,
  Database,
  Id,
  MasterDataRecord,
  Organisation,
} from "../fake/types.js";
import { useSession } from "../session.js";
import { Badge, Card, Empty, Input, NotConnectedBanner, Select } from "../ui/index.js";

export function LenderCatalogue(): ReactNode {
  const db = useDatabase();
  const session = useSession();

  const [query, setQuery] = useState("");
  const [lenderTypeId, setLenderTypeId] = useState<Id | "">("");
  const [districtId, setDistrictId] = useState<Id | "">("");
  const [loanProductId, setLoanProductId] = useState<Id | "">("");
  const [workingWithOnly, setWorkingWithOnly] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  const [expanded, setExpanded] = useState<Id | null>(null);

  // Every hook runs before the permission gate below, because a hook behind a
  // conditional return is the one React rule this screen could plausibly break.
  const view = useMemo(() => lendersAsDomain(db), [db]);
  const byCode = useMemo(
    () => new Map(view.institutions.map((institution) => [institution.code, institution])),
    [view],
  );

  const filter: LenderFilter = {
    query,
    ...(codeOf(db.lenderTypes, lenderTypeId) !== undefined
      ? { lenderTypeCode: codeOf(db.lenderTypes, lenderTypeId) as string }
      : {}),
    ...(codeOf(db.districts, districtId) !== undefined
      ? { districtCode: codeOf(db.districts, districtId) as string }
      : {}),
    ...(productCodeOf(db, loanProductId) !== undefined
      ? { lendingProductCode: productCodeOf(db, loanProductId) as string }
      : {}),
    onPanelOnly: workingWithOnly,
    includeInactive: showClosed,
  };

  const matchedCodes = useMemo(
    () =>
      new Set(
        filterLenders(view.institutions, filter, {
          branches: view.branches,
          supportedProducts: view.supportedProducts,
        }).map((institution) => institution.code),
      ),
    // The filter object is rebuilt each render; its fields are the real
    // dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, query, lenderTypeId, districtId, loanProductId, workingWithOnly, showClosed],
  );

  if (!session.can("master_data.read", "all")) {
    return (
      <Card title="Not permitted">
        <p className="text-sm text-ink-700">
          This user does not hold <code>master_data.read</code>.
        </p>
      </Card>
    );
  }

  const visible = db.lenderProfiles
    .filter((profile) => profile.code !== undefined && matchedCodes.has(profile.code))
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder);

  const filtersApplied =
    query.trim().length > 0 ||
    lenderTypeId !== "" ||
    districtId !== "" ||
    loanProductId !== "" ||
    workingWithOnly;

  const clearFilters = (): void => {
    setQuery("");
    setLenderTypeId("");
    setDistrictId("");
    setLoanProductId("");
    setWorkingWithOnly(false);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Lenders</h1>
        <p className="mt-1 text-sm text-ink-500">
          Every bank, NBFC and housing finance company Amaze works with — their branches, the
          people we deal with, the products they do, and what the office has learned about working
          with them. Read-only reference — see the note below.
        </p>
        <NotConnectedBanner />
      </div>

      <Card
        title={`${visible.length} of ${db.lenderProfiles.length} lenders`}
        subtitle="Search by name, short name, region or head office. Words can be in any order."
      >
        <div className="space-y-3">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="indian bank · chola · housing · tamil nadu"
          />

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <FilterSelect
              label="Kind of lender"
              value={lenderTypeId}
              onChange={setLenderTypeId}
              options={db.lenderTypes}
            />
            <FilterSelect
              label="Has a branch in"
              value={districtId}
              onChange={setDistrictId}
              options={db.districts}
            />
            <label className="block">
              <span className="block text-xs font-medium text-ink-700">Does this product</span>
              <Select
                value={loanProductId}
                onChange={(event) => setLoanProductId(event.target.value)}
              >
                <option value="">Any</option>
                {db.loanProducts
                  .filter((product) => product.isActive)
                  .slice()
                  .sort((a, b) => a.displayOrder - b.displayOrder)
                  .map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name ?? product.variant}
                    </option>
                  ))}
              </Select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-ink-700">
              <input
                type="checkbox"
                checked={workingWithOnly}
                onChange={(event) => setWorkingWithOnly(event.target.checked)}
              />
              Only lenders we currently work with
            </label>
            <label className="flex items-center gap-2 text-xs text-ink-700">
              <input
                type="checkbox"
                checked={showClosed}
                onChange={(event) => setShowClosed(event.target.checked)}
              />
              Show lenders that no longer exist
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
              No lender matches. Try fewer words, or clear the filters — a lender that no longer
              exists is hidden unless you ask for it.
            </Empty>
          ) : (
            <ul className="divide-y divide-ink-100">
              {visible.map((profile) => {
                const institution = byCode.get(profile.code as string);
                if (!institution) return null;
                const organisation = db.organisations.find(
                  (org) => org.id === profile.organisationId,
                );
                if (!organisation) return null;
                const availability = lenderAvailability(institution);
                const branches = branchesOf(institution, view.branches);
                const products = supportedProductCodes(institution, {
                  branches: view.branches,
                  supportedProducts: view.supportedProducts,
                });

                return (
                  <li key={profile.organisationId} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex items-start gap-3">
                      <button
                        className="min-w-0 flex-1 text-left"
                        onClick={() =>
                          setExpanded(
                            expanded === profile.organisationId ? null : profile.organisationId,
                          )
                        }
                      >
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {organisation.canonicalName}
                          <Badge tone="info">
                            {nameOf(db.lenderTypes, profile.lenderTypeId) ?? "Lender"}
                          </Badge>
                          {availability === "off_panel" && (
                            <Badge tone="neutral">Not currently used</Badge>
                          )}
                          {availability === "inactive" && (
                            <Badge tone="neutral">No longer exists</Badge>
                          )}
                        </p>
                        <p className="mt-0.5 text-xs text-ink-500">
                          {[
                            profile.primaryServiceRegion,
                            describeBranchCount(branches.length),
                            products.size > 0 ? `${products.size} products` : undefined,
                            describeTurnaround(profile.typicalTurnaroundDays),
                          ]
                            .filter((part) => part !== undefined && part !== "")
                            .join(" · ")}
                        </p>
                      </button>
                    </div>

                    {expanded === profile.organisationId && (
                      <LenderDetail
                        db={db}
                        view={view}
                        institution={institution}
                        organisation={organisation}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>

      <Card
        title="What this screen is, and what it is not"
        subtitle="Worth being explicit, because the difference decides what AOS may do with it later."
      >
        <ul className="space-y-2 text-sm text-ink-700">
          <li>
            <span className="font-medium">Facts about a lender</span> — what kind it is, where it
            lends, which branches, which products, who to call. Reliable as reference, and safe for
            anything to read.
          </li>
          <li>
            <span className="font-medium">What we know</span> — the office's own experience, in the
            words of whoever learned it. Guidance, never a rule. Nothing in AOS decides anything
            from it, and when the assistant arrives it will quote these as something the team
            observed, not as a condition it checked.
          </li>
          <li>
            <span className="font-medium">Not here yet</span> — maintaining this catalogue from
            AOS. The data on this screen is a per-browser preview, not the office database; adding
            or editing a lender's details is not available here (see the banner above). Choosing a
            lender for a case, eligibility, submitting a file, turnaround reporting are separate,
            later milestones.
          </li>
        </ul>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function codeOf(list: readonly MasterDataRecord[], id: Id | ""): string | undefined {
  if (!id) return undefined;
  return list.find((record) => record.id === id)?.code;
}

function productCodeOf(db: Database, id: Id | ""): string | undefined {
  if (!id) return undefined;
  return db.loanProducts.find((product) => product.id === id)?.code;
}

function nameOf(list: readonly MasterDataRecord[], id?: Id): string | undefined {
  if (!id) return undefined;
  return list.find((record) => record.id === id)?.name;
}

function activeSorted(list: readonly MasterDataRecord[]): MasterDataRecord[] {
  return list
    .filter((record) => record.isActive)
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder);
}

const BRANCH_STATUS_LABELS: Record<BranchStatus, string> = {
  operational: "Open",
  temporarily_closed: "Temporarily closed",
  closed: "Closed",
};

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
        {activeSorted(options).map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </Select>
    </label>
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
// The expanded lender: six read-only sections, one per concept.
// ---------------------------------------------------------------------------

type Panel = "about" | "branches" | "contacts" | "products" | "submission" | "knowledge";

const PANEL_LABELS: Record<Panel, string> = {
  about: "About",
  branches: "Branches",
  contacts: "People we deal with",
  products: "Products they do",
  submission: "How to submit",
  knowledge: "What we know",
};

function LenderDetail({
  db,
  view,
  institution,
  organisation,
}: {
  db: Database;
  view: ReturnType<typeof lendersAsDomain>;
  institution: LenderInstitution;
  organisation: Organisation;
}): ReactNode {
  const [panel, setPanel] = useState<Panel>("about");

  return (
    <div className="mt-3 rounded-md bg-ink-50 p-3">
      <div className="flex flex-wrap gap-1">
        {(Object.keys(PANEL_LABELS) as Panel[]).map((key) => (
          <button
            key={key}
            onClick={() => setPanel(key)}
            className={
              panel === key
                ? "rounded-md bg-white px-2.5 py-1 text-xs font-medium text-ink-900 ring-1 ring-ink-200"
                : "rounded-md px-2.5 py-1 text-xs font-medium text-ink-500 hover:text-ink-700"
            }
          >
            {PANEL_LABELS[key]}
          </button>
        ))}
      </div>

      <div className="mt-3">
        {panel === "about" && <AboutPanel db={db} organisation={organisation} />}
        {panel === "branches" && <BranchesPanel db={db} organisation={organisation} />}
        {panel === "contacts" && <ContactsPanel db={db} organisation={organisation} />}
        {panel === "products" && <ProductsPanel db={db} organisation={organisation} />}
        {panel === "submission" && (
          <SubmissionPanel db={db} view={view} institution={institution} />
        )}
        {panel === "knowledge" && (
          <KnowledgePanel db={db} view={view} institution={institution} organisation={organisation} />
        )}
      </div>
    </div>
  );
}

function AboutPanel({ db, organisation }: { db: Database; organisation: Organisation }): ReactNode {
  const profile = db.lenderProfiles.find((p) => p.organisationId === organisation.id);
  if (!profile) return null;

  const institution = db.organisations.find((org) => org.id === organisation.id);

  return (
    <div className="space-y-3">
      <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
        <Detail label="Kind of lender">
          {nameOf(db.lenderTypes, profile.lenderTypeId) ?? "—"}
        </Detail>
        <Detail label="Short name">{profile.code ?? "—"}</Detail>
        <Detail label="Head office">{profile.headOfficeCity ?? "—"}</Detail>
        <Detail label="Where they lend">{profile.primaryServiceRegion ?? "—"}</Detail>
        <Detail label="Do we work with them?">
          {profile.isOnPanel ? "Yes" : "Not at the moment"}
        </Detail>
        <Detail label="Usual turnaround">
          {describeTurnaround(profile.typicalTurnaroundDays) ?? "Not recorded"}
        </Detail>
        <Detail label="Website">
          {profile.websiteUrl ? (
            <a
              href={profile.websiteUrl}
              target="_blank"
              rel="noreferrer"
              className="text-brand-700 hover:underline"
            >
              {profile.websiteUrl}
            </a>
          ) : (
            "—"
          )}
        </Detail>
        <Detail label="Also known as">
          {institution?.aliases && institution.aliases.length > 0
            ? institution.aliases.join(", ")
            : "—"}
        </Detail>
      </dl>

      {(profile.preferredCustomerSegments ??
        profile.knownStrengths ??
        profile.knownLimitations ??
        profile.commonRejectionPatterns ??
        profile.internalRemarks) && (
        <dl className="grid gap-x-6 gap-y-2 border-t border-ink-200 pt-3 text-xs sm:grid-cols-2">
          {profile.preferredCustomerSegments && (
            <Detail label="Customers they prefer">{profile.preferredCustomerSegments}</Detail>
          )}
          {profile.knownStrengths && <Detail label="Good at">{profile.knownStrengths}</Detail>}
          {profile.knownLimitations && (
            <Detail label="Difficult about">{profile.knownLimitations}</Detail>
          )}
          {profile.commonRejectionPatterns && (
            <Detail label="Usually declines">{profile.commonRejectionPatterns}</Detail>
          )}
          {profile.internalRemarks && (
            <Detail label="Internal remarks">{profile.internalRemarks}</Detail>
          )}
        </dl>
      )}

      {profile.notes && <p className="text-xs text-ink-500">{profile.notes}</p>}

      <p className="text-xs text-ink-500">
        Everything in the second block is the office's own view of this lender. It is written down
        so it stops living in two people's heads — it is not an eligibility rule, and nothing in
        AOS decides anything from it.
      </p>
    </div>
  );
}

function BranchesPanel({ db, organisation }: { db: Database; organisation: Organisation }): ReactNode {
  const branches = db.organisations
    .filter((org) => org.parentOrganisationId === organisation.id && org.roles.includes("branch"))
    .map((org) => ({
      org,
      branch: db.bankBranches.find((b) => b.organisationId === org.id),
    }))
    .filter((row): row is { org: Organisation; branch: BankBranch } => row.branch !== undefined);

  return (
    <div className="space-y-3">
      {branches.length === 0 ? (
        <Empty>No branches recorded yet.</Empty>
      ) : (
        <ul className="space-y-2">
          {branches.map(({ org, branch }) => (
            <li key={org.id} className="rounded-md bg-white p-2.5 ring-1 ring-ink-200">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {org.canonicalName}
                {branch.operationalStatus !== "operational" && (
                  <Badge tone="neutral">{BRANCH_STATUS_LABELS[branch.operationalStatus]}</Badge>
                )}
              </p>
              <p className="mt-0.5 text-xs text-ink-500">
                {[
                  nameOf(db.cities, branch.cityId),
                  nameOf(db.districts, branch.districtId),
                  branch.addressLine,
                  branch.contactNumber,
                  branch.email,
                ]
                  .filter((part) => part !== undefined && part !== "")
                  .join(" · ") || "Address and phone not filled in yet."}
              </p>
              {branch.notes && <p className="mt-1 text-xs text-ink-400">{branch.notes}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ContactsPanel({ db, organisation }: { db: Database; organisation: Organisation }): ReactNode {
  const contacts = db.bankContacts.filter(
    (contact) => contact.institutionOrganisationId === organisation.id,
  );

  return (
    <div className="space-y-3">
      {contacts.length === 0 ? (
        <Empty>Nobody recorded yet.</Empty>
      ) : (
        <ul className="space-y-2">
          {contacts.map((contact) => {
            const branch = db.organisations.find((o) => o.id === contact.branchOrganisationId);
            return (
              <li key={contact.id} className="rounded-md bg-white p-2.5 ring-1 ring-ink-200">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {contactLabel(contact, db)}
                  <Badge tone="info">
                    {nameOf(db.lenderRelationshipRoles, contact.relationshipRoleId) ??
                      contact.designation ??
                      "Contact"}
                  </Badge>
                  {contact.isPrimaryContact && <Badge tone="good">Primary</Badge>}
                  {!contact.isActive && <Badge tone="neutral">Moved on</Badge>}
                </p>
                <p className="mt-0.5 text-xs text-ink-500">
                  {[branch?.canonicalName ?? "No specific branch", contact.workMobile, contact.workEmail]
                    .filter((part) => part !== undefined && part !== "")
                    .join(" · ")}
                </p>
                {contact.notes && <p className="mt-1 text-xs text-ink-400">{contact.notes}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ProductsPanel({ db, organisation }: { db: Database; organisation: Organisation }): ReactNode {
  const branchIds = new Set(
    db.organisations
      .filter((org) => org.parentOrganisationId === organisation.id)
      .map((org) => org.id),
  );
  const entries = db.bankProducts.filter(
    (entry) => entry.organisationId === organisation.id || branchIds.has(entry.organisationId),
  );

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-500">
        Which of Amaze's lending products this lender does. The products themselves are defined
        once, on the Products screen — this only points at them.
      </p>

      {entries.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        <ul className="space-y-1.5">
          {entries.map((entry) => {
            const product = db.loanProducts.find((p) => p.id === entry.loanProductId);
            const at = db.organisations.find((o) => o.id === entry.organisationId);
            return (
              <li key={entry.id} className="rounded-md bg-white p-2.5 ring-1 ring-ink-200">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  {entry.name}
                  <Badge tone="neutral">{product?.name ?? product?.variant ?? "Unknown"}</Badge>
                  {!entry.isActive && <Badge tone="neutral">Withdrawn</Badge>}
                </p>
                {at && at.id !== organisation.id && (
                  <p className="mt-0.5 text-xs text-ink-500">Only at {at.canonicalName}</p>
                )}
                {entry.notes && <p className="mt-0.5 text-xs text-ink-400">{entry.notes}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SubmissionPanel({
  db,
  view,
  institution,
}: {
  db: Database;
  view: ReturnType<typeof lendersAsDomain>;
  institution: LenderInstitution;
}): ReactNode {
  const branchIds = view.branches
    .filter((branch) => branch.institutionCode === institution.code)
    .map((branch) => branch.id);
  const rules = submissionRulesFor([institution.code, ...branchIds], view.submissionRules);

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-500">
        How a file goes in, and what to have ready. Notes for the person lodging it — AOS does not
        act on any of this.
      </p>

      {rules.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        <ul className="space-y-2">
          {rules.map((rule) => {
            const stored = db.lenderSubmissionRules.find((r) => r.id === rule.id);
            const product = db.loanProducts.find((p) => p.id === stored?.loanProductId);
            return (
              <li key={rule.id} className="rounded-md bg-white p-2.5 ring-1 ring-ink-200">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {nameOf(db.submissionModes, stored?.submissionModeId) ?? "How to submit"}
                  <Badge tone="neutral">
                    {product ? (product.name ?? product.variant) : "All products"}
                  </Badge>
                </p>
                <dl className="mt-1 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                  {rule.portalUrl && <Detail label="Portal">{rule.portalUrl}</Detail>}
                  {rule.whatToCarry && <Detail label="Carry">{rule.whatToCarry}</Detail>}
                  {rule.loginFeeNotes && <Detail label="Login fee">{rule.loginFeeNotes}</Detail>}
                  {rule.turnaroundNotes && (
                    <Detail label="What comes back">{rule.turnaroundNotes}</Detail>
                  )}
                </dl>
                {rule.notes && <p className="mt-1 text-xs text-ink-500">{rule.notes}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The lender profile — the heart of the milestone's extra recommendation.
 *
 * Categorised free text and nothing more. The category is what makes a note
 * retrievable later and what stops "known limitation" ever reading like
 * "process tip"; the free text is what makes it honest (ADR-034).
 */
function KnowledgePanel({
  db,
  view,
  institution,
  organisation,
}: {
  db: Database;
  view: ReturnType<typeof lendersAsDomain>;
  institution: LenderInstitution;
  organisation: Organisation;
}): ReactNode {
  const branchIds = view.branches
    .filter((branch) => branch.institutionCode === institution.code)
    .map((branch) => branch.id);
  const categoryOrder = activeSorted(db.lenderInsightCategories).map((c) => c.code);
  const groups = insightsFor([institution.code, ...branchIds], view.insights, categoryOrder);

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-500">
        What the office has learned about working with this lender. Written by people, for people.
        Not a rule — nothing in AOS decides anything from it, and it never overrides what a lender
        actually says.
      </p>

      {groups.length === 0 ? (
        <Empty>
          Nothing written down yet. This is the box for the things that never fit anywhere else —
          "good with textile units", "always asks for an extra year of ITR", "the manager prefers
          WhatsApp before email".
        </Empty>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => {
            const category = db.lenderInsightCategories.find((c) => c.code === group.categoryCode);
            return (
              <div key={group.categoryCode}>
                <p className="text-xs font-medium text-ink-700">
                  {category?.name ?? group.categoryCode}
                </p>
                <ul className="mt-1 space-y-1.5">
                  {group.insights.map((insight) => {
                    const stored = db.lenderInsights.find((i) => i.id === insight.id);
                    const product = db.loanProducts.find((p) => p.id === stored?.loanProductId);
                    const at = db.organisations.find((o) => o.id === stored?.organisationId);
                    return (
                      <li key={insight.id} className="rounded-md bg-white p-2.5 ring-1 ring-ink-200">
                        <p className="text-sm text-ink-700">{insight.body}</p>
                        <p className="mt-0.5 text-xs text-ink-400">
                          {[
                            insight.observedOn ? `Noted ${insight.observedOn}` : undefined,
                            product ? (product.name ?? product.variant) : undefined,
                            at && at.id !== organisation.id ? at.canonicalName : undefined,
                          ]
                            .filter((part) => part !== undefined)
                            .join(" · ")}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
