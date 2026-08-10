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

import {
  addLenderInsight,
  addSupportedProduct,
  contactLabel,
  createBranch,
  createInstitution,
  createRelationshipManager,
  createSubmissionRule,
  lendersAsDomain,
  setInstitutionActive,
  setLenderInsightActive,
  setRelationshipManagerActive,
  setSubmissionRuleActive,
  setSupportedProductActive,
  updateBranch,
  updateInstitution,
  updateRelationshipManager,
  type BranchInput,
  type InstitutionInput,
  type LenderInsightInput,
  type RelationshipManagerInput,
  type SubmissionRuleInput,
} from "../fake/store.js";
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
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Modal,
  NotConnectedBanner,
  Select,
  Textarea,
  useToast,
} from "../ui/index.js";

export function LenderCatalogue(): ReactNode {
  const db = useDatabase();
  const session = useSession();

  const [query, setQuery] = useState("");
  const [lenderTypeId, setLenderTypeId] = useState<Id | "">("");
  const [districtId, setDistrictId] = useState<Id | "">("");
  const [loanProductId, setLoanProductId] = useState<Id | "">("");
  const [workingWithOnly, setWorkingWithOnly] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<Id | null>(null);

  const canManage = session.can("master_data.manage", "all");

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
          with them.
          {!canManage && " This user can view but not edit — hold master_data.manage to make changes."}
        </p>
        <NotConnectedBanner />
      </div>

      <Card
        title={`${visible.length} of ${db.lenderProfiles.length} lenders`}
        subtitle="Search by name, short name, region or head office. Words can be in any order."
        actions={
          canManage && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add lender
            </Button>
          )
        }
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
                        canManage={canManage}
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
            lends, which branches, which products, who to call. Reliable, and safe for anything to
            read.
          </li>
          <li>
            <span className="font-medium">What we know</span> — the office's own experience, in the
            words of whoever learned it. Guidance, never a rule. Nothing in AOS decides anything
            from it, and when the assistant arrives it will quote these as something the team
            observed, not as a condition it checked.
          </li>
          <li>
            <span className="font-medium">Not here yet</span> — choosing a lender for a case,
            eligibility, submitting a file, turnaround reporting. Each is its own milestone, and
            each reads this screen rather than replacing it.
          </li>
        </ul>
      </Card>

      {adding && (
        <InstitutionForm
          title="Add lender"
          db={db}
          onClose={() => setAdding(false)}
          onSaved={() => setAdding(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

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

/**
 * The name to put in the edit form's Name box — blank rather than a
 * placeholder when the contact is a desk.
 *
 * `contactLabel` falls back to the email so that a list row always says
 * something. Doing that here would pre-fill the Name field with an email
 * address, and the first person to save the form would turn a nameless
 * mailbox into one named after itself.
 */
function contactLabelOrBlank(contact: BankContact, db: Database): string {
  return (
    contact.contactName ??
    db.people.find((person) => person.id === contact.personId)?.fullName ??
    ""
  );
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
// The expanded lender: six sections, one per concept.
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
  canManage,
}: {
  db: Database;
  view: ReturnType<typeof lendersAsDomain>;
  institution: LenderInstitution;
  organisation: Organisation;
  canManage: boolean;
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
        {panel === "about" && (
          <AboutPanel
            db={db}
            institution={institution}
            organisation={organisation}
            canManage={canManage}
          />
        )}
        {panel === "branches" && (
          <BranchesPanel db={db} organisation={organisation} canManage={canManage} />
        )}
        {panel === "contacts" && (
          <ContactsPanel db={db} organisation={organisation} canManage={canManage} />
        )}
        {panel === "products" && (
          <ProductsPanel db={db} organisation={organisation} canManage={canManage} />
        )}
        {panel === "submission" && (
          <SubmissionPanel
            db={db}
            view={view}
            institution={institution}
            organisation={organisation}
            canManage={canManage}
          />
        )}
        {panel === "knowledge" && (
          <KnowledgePanel
            db={db}
            view={view}
            institution={institution}
            organisation={organisation}
            canManage={canManage}
          />
        )}
      </div>
    </div>
  );
}

function AboutPanel({
  db,
  institution,
  organisation,
  canManage,
}: {
  db: Database;
  institution: LenderInstitution;
  organisation: Organisation;
  canManage: boolean;
}): ReactNode {
  const toast = useToast();
  const session = useSession();
  const [editing, setEditing] = useState(false);
  const profile = db.lenderProfiles.find((p) => p.organisationId === organisation.id);
  if (!profile) return null;

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
          {institution.aliases && institution.aliases.length > 0
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
          {profile.knownStrengths && (
            <Detail label="Good at">{profile.knownStrengths}</Detail>
          )}
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

      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setEditing(true)}>Edit lender</Button>
          <Button
            onClick={() => {
              const nextActive = organisation.isActive === false;
              const result = setInstitutionActive(organisation.id, nextActive, session.user.id);
              toast.show(
                result.ok
                  ? `${organisation.canonicalName} ${nextActive ? "reactivated" : "marked as no longer existing"}.`
                  : (result.message ?? "Could not update."),
                result.ok ? "good" : "bad",
              );
            }}
          >
            {organisation.isActive === false ? "Reactivate" : "No longer exists"}
          </Button>
        </div>
      )}

      {editing && (
        <InstitutionForm
          title="Edit lender"
          db={db}
          organisationId={organisation.id}
          onClose={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      )}
    </div>
  );
}

function BranchesPanel({
  db,
  organisation,
  canManage,
}: {
  db: Database;
  organisation: Organisation;
  canManage: boolean;
}): ReactNode {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<BankBranch | null>(null);

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
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {org.canonicalName}
                    {branch.operationalStatus !== "operational" && (
                      <Badge tone="neutral">
                        {BRANCH_STATUS_LABELS[branch.operationalStatus]}
                      </Badge>
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
                </div>
                {canManage && <Button onClick={() => setEditing(branch)}>Edit</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {canManage && <Button onClick={() => setAdding(true)}>Add branch</Button>}

      {adding && (
        <BranchForm
          title="Add branch"
          db={db}
          institutionOrganisationId={organisation.id}
          onClose={() => setAdding(false)}
        />
      )}
      {editing && (
        <BranchForm
          title="Edit branch"
          db={db}
          institutionOrganisationId={organisation.id}
          initial={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ContactsPanel({
  db,
  organisation,
  canManage,
}: {
  db: Database;
  organisation: Organisation;
  canManage: boolean;
}): ReactNode {
  const session = useSession();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<BankContact | null>(null);

  const contacts = db.bankContacts.filter(
    (contact) => contact.institutionOrganisationId === organisation.id,
  );

  return (
    <div className="space-y-3">
      {contacts.length === 0 ? (
        <Empty>
          Nobody recorded yet. Add the manager you actually deal with, and the branch's shared
          mailbox alongside them — the number and email here belong to the posting, so if somebody
          moves banks you add a new contact rather than editing this one. These are the addresses
          the Add Bank workflow offers when a file goes out.
        </Empty>
      ) : (
        <ul className="space-y-2">
          {contacts.map((contact) => {
            const branch = db.organisations.find((o) => o.id === contact.branchOrganisationId);
            return (
              <li key={contact.id} className="rounded-md bg-white p-2.5 ring-1 ring-ink-200">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
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
                      {[
                        branch?.canonicalName ?? "No specific branch",
                        contact.workMobile,
                        contact.workEmail,
                      ]
                        .filter((part) => part !== undefined && part !== "")
                        .join(" · ")}
                    </p>
                    {contact.notes && <p className="mt-1 text-xs text-ink-400">{contact.notes}</p>}
                  </div>
                  {canManage && (
                    <div className="flex shrink-0 gap-2">
                      <Button onClick={() => setEditing(contact)}>Edit</Button>
                      <Button
                        onClick={() => {
                          const result = setRelationshipManagerActive(
                            contact.id,
                            !contact.isActive,
                            session.user.id,
                          );
                          toast.show(
                            result.ok
                              ? contact.isActive
                                ? "Marked as moved on."
                                : "Marked as current again."
                              : (result.message ?? "Could not update."),
                            result.ok ? "good" : "bad",
                          );
                        }}
                      >
                        {contact.isActive ? "Moved on" : "Still here"}
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {canManage && <Button onClick={() => setAdding(true)}>Add contact</Button>}

      {adding && (
        <ContactForm
          title="Add contact"
          db={db}
          institutionOrganisationId={organisation.id}
          onClose={() => setAdding(false)}
        />
      )}
      {editing && (
        <ContactForm
          title="Edit contact"
          db={db}
          institutionOrganisationId={organisation.id}
          initial={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ProductsPanel({
  db,
  organisation,
  canManage,
}: {
  db: Database;
  organisation: Organisation;
  canManage: boolean;
}): ReactNode {
  const session = useSession();
  const toast = useToast();
  const [chosen, setChosen] = useState<Id | "">("");

  const branchIds = new Set(
    db.organisations
      .filter((org) => org.parentOrganisationId === organisation.id)
      .map((org) => org.id),
  );
  const entries = db.bankProducts.filter(
    (entry) =>
      entry.organisationId === organisation.id || branchIds.has(entry.organisationId),
  );
  const alreadyOffered = new Set(entries.filter((e) => e.isActive).map((e) => e.loanProductId));

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
              <li
                key={entry.id}
                className="flex items-start gap-3 rounded-md bg-white p-2.5 ring-1 ring-ink-200"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    {entry.name}
                    <Badge tone="neutral">{product?.name ?? product?.variant ?? "Unknown"}</Badge>
                    {!entry.isActive && <Badge tone="neutral">Withdrawn</Badge>}
                  </p>
                  {at && at.id !== organisation.id && (
                    <p className="mt-0.5 text-xs text-ink-500">Only at {at.canonicalName}</p>
                  )}
                  {entry.notes && <p className="mt-0.5 text-xs text-ink-400">{entry.notes}</p>}
                </div>
                {canManage && (
                  <Button
                    onClick={() => {
                      const result = setSupportedProductActive(
                        entry.id,
                        !entry.isActive,
                        session.user.id,
                      );
                      toast.show(
                        result.ok
                          ? entry.isActive
                            ? "Marked as withdrawn."
                            : "Restored."
                          : (result.message ?? "Could not update."),
                        result.ok ? "good" : "bad",
                      );
                    }}
                  >
                    {entry.isActive ? "Withdrawn" : "Restore"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canManage && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="block min-w-56 flex-1">
            <span className="block text-xs font-medium text-ink-700">Add a product they do</span>
            <Select value={chosen} onChange={(event) => setChosen(event.target.value)}>
              <option value="">— Choose —</option>
              {db.loanProducts
                .filter((product) => product.isActive && !alreadyOffered.has(product.id))
                .slice()
                .sort((a, b) => a.displayOrder - b.displayOrder)
                .map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name ?? product.variant}
                  </option>
                ))}
            </Select>
          </label>
          <Button
            variant="primary"
            disabled={chosen === ""}
            onClick={() => {
              const result = addSupportedProduct(
                { organisationId: organisation.id, loanProductId: chosen },
                session.user.id,
              );
              if (result.ok) setChosen("");
              toast.show(
                result.ok ? "Added." : (result.message ?? "Could not add."),
                result.ok ? "good" : "bad",
              );
            }}
          >
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

function SubmissionPanel({
  db,
  view,
  institution,
  organisation,
  canManage,
}: {
  db: Database;
  view: ReturnType<typeof lendersAsDomain>;
  institution: LenderInstitution;
  organisation: Organisation;
  canManage: boolean;
}): ReactNode {
  const session = useSession();
  const toast = useToast();
  const [adding, setAdding] = useState(false);

  const branchIds = view.branches
    .filter((branch) => branch.institutionCode === institution.code)
    .map((branch) => branch.id);
  const rules = submissionRulesFor(
    [institution.code, ...branchIds],
    view.submissionRules,
  );

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
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {nameOf(db.submissionModes, stored?.submissionModeId) ?? "How to submit"}
                      <Badge tone="neutral">
                        {product ? (product.name ?? product.variant) : "All products"}
                      </Badge>
                    </p>
                    <dl className="mt-1 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                      {rule.portalUrl && <Detail label="Portal">{rule.portalUrl}</Detail>}
                      {rule.whatToCarry && <Detail label="Carry">{rule.whatToCarry}</Detail>}
                      {rule.loginFeeNotes && (
                        <Detail label="Login fee">{rule.loginFeeNotes}</Detail>
                      )}
                      {rule.turnaroundNotes && (
                        <Detail label="What comes back">{rule.turnaroundNotes}</Detail>
                      )}
                    </dl>
                    {rule.notes && <p className="mt-1 text-xs text-ink-500">{rule.notes}</p>}
                  </div>
                  {canManage && (
                    <Button
                      onClick={() => {
                        // Deactivated, never deleted — the same convention
                        // every other reference table in this store follows.
                        const result = setSubmissionRuleActive(
                          rule.id,
                          false,
                          session.user.id,
                        );
                        toast.show(
                          result.ok ? "Removed." : (result.message ?? "Could not remove."),
                          result.ok ? "good" : "bad",
                        );
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {canManage && <Button onClick={() => setAdding(true)}>Add a submission note</Button>}

      {adding && (
        <SubmissionRuleForm
          db={db}
          organisation={organisation}
          onClose={() => setAdding(false)}
        />
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
  canManage,
}: {
  db: Database;
  view: ReturnType<typeof lendersAsDomain>;
  institution: LenderInstitution;
  organisation: Organisation;
  canManage: boolean;
}): ReactNode {
  const session = useSession();
  const toast = useToast();
  const [adding, setAdding] = useState(false);

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
                      <li
                        key={insight.id}
                        className="flex items-start gap-3 rounded-md bg-white p-2.5 ring-1 ring-ink-200"
                      >
                        <div className="min-w-0 flex-1">
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
                        </div>
                        {canManage && (
                          <Button
                            onClick={() => {
                              const result = setLenderInsightActive(
                                insight.id,
                                false,
                                session.user.id,
                              );
                              toast.show(
                                result.ok
                                  ? "Retired — kept in history, hidden here."
                                  : (result.message ?? "Could not retire."),
                                result.ok ? "good" : "bad",
                              );
                            }}
                          >
                            Retire
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {canManage && <Button onClick={() => setAdding(true)}>Add what we know</Button>}

      {adding && (
        <InsightForm db={db} organisation={organisation} onClose={() => setAdding(false)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forms.
//
// Grouped the way the questions come rather than in schema order, and worded
// the way office staff ask them.
// ---------------------------------------------------------------------------

function InstitutionForm({
  title,
  db,
  organisationId,
  onClose,
  onSaved,
}: {
  title: string;
  db: Database;
  organisationId?: Id;
  onClose: () => void;
  onSaved?: () => void;
}): ReactNode {
  const session = useSession();
  const toast = useToast();
  const profile = db.lenderProfiles.find((p) => p.organisationId === organisationId);
  const organisation = db.organisations.find((o) => o.id === organisationId);

  const [name, setName] = useState(organisation?.canonicalName ?? "");
  const [code, setCode] = useState(profile?.code ?? "");
  const [lenderTypeId, setLenderTypeId] = useState(profile?.lenderTypeId ?? "");
  const [headOfficeCity, setHeadOfficeCity] = useState(profile?.headOfficeCity ?? "");
  const [region, setRegion] = useState(profile?.primaryServiceRegion ?? "");
  const [websiteUrl, setWebsiteUrl] = useState(profile?.websiteUrl ?? "");
  const [isOnPanel, setIsOnPanel] = useState(profile?.isOnPanel ?? true);
  const [turnaround, setTurnaround] = useState(String(profile?.typicalTurnaroundDays ?? ""));
  const [segments, setSegments] = useState(profile?.preferredCustomerSegments ?? "");
  const [strengths, setStrengths] = useState(profile?.knownStrengths ?? "");
  const [limitations, setLimitations] = useState(profile?.knownLimitations ?? "");
  const [rejections, setRejections] = useState(profile?.commonRejectionPatterns ?? "");
  const [remarks, setRemarks] = useState(profile?.internalRemarks ?? "");
  const [notes, setNotes] = useState(profile?.notes ?? "");

  const ready = name.trim().length > 0 && code.trim().length > 0 && lenderTypeId !== "";

  const build = (): InstitutionInput => ({
    name,
    code,
    lenderTypeId,
    isOnPanel,
    ...(headOfficeCity ? { headOfficeCity } : {}),
    ...(region ? { primaryServiceRegion: region } : {}),
    ...(websiteUrl ? { websiteUrl } : {}),
    ...(turnaround.trim() ? { typicalTurnaroundDays: Number(turnaround) } : {}),
    ...(segments ? { preferredCustomerSegments: segments } : {}),
    ...(strengths ? { knownStrengths: strengths } : {}),
    ...(limitations ? { knownLimitations: limitations } : {}),
    ...(rejections ? { commonRejectionPatterns: rejections } : {}),
    ...(remarks ? { internalRemarks: remarks } : {}),
    ...(notes ? { notes } : {}),
  });

  return (
    <Modal open title={title} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Lender name" hint="The full name, as it appears on their letterhead.">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Karur Vysya Bank"
            />
          </Field>
          <Field label="Short name" hint="Internal, stable, lowercase_with_underscores.">
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={organisationId !== undefined}
              placeholder="e.g. kvb"
            />
          </Field>
        </div>

        <Field label="Kind of lender" hint="Managed under Master Data — add a new kind there.">
          <Select value={lenderTypeId} onChange={(event) => setLenderTypeId(event.target.value)}>
            <option value="">— Choose —</option>
            {activeSorted(db.lenderTypes).map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Head office">
            <Input
              value={headOfficeCity}
              onChange={(event) => setHeadOfficeCity(event.target.value)}
              placeholder="e.g. Karur"
            />
          </Field>
          <Field label="Where they lend" hint="In your own words. Leave blank if unsure.">
            <Input
              value={region}
              onChange={(event) => setRegion(event.target.value)}
              placeholder="e.g. Tamil Nadu and Kerala"
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Website">
            <Input value={websiteUrl} onChange={(event) => setWebsiteUrl(event.target.value)} />
          </Field>
          <Field
            label="Usual turnaround, days"
            hint="What the office actually sees. Guidance, not a deadline."
          >
            <Input
              type="number"
              value={turnaround}
              onChange={(event) => setTurnaround(event.target.value)}
            />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={isOnPanel}
            onChange={(event) => setIsOnPanel(event.target.checked)}
          />
          We currently work with this lender
        </label>

        <div className="border-t border-ink-100 pt-3">
          <p className="text-xs font-medium text-ink-700">What the office knows</p>
          <p className="text-xs text-ink-500">
            All optional, all free text, all guidance. Leave anything blank rather than guessing —
            a plausible wrong answer here is worse than an empty box.
          </p>
        </div>

        <Field label="Customers they prefer">
          <Input
            value={segments}
            onChange={(event) => setSegments(event.target.value)}
            placeholder="e.g. Salaried, MSME manufacturing, textile units"
          />
        </Field>
        <Field label="Good at">
          <Textarea value={strengths} onChange={(event) => setStrengths(event.target.value)} />
        </Field>
        <Field label="Difficult about">
          <Textarea value={limitations} onChange={(event) => setLimitations(event.target.value)} />
        </Field>
        <Field
          label="Usually declines"
          hint="What they tend to say no to. Separate from the rejection reason recorded on an actual rejected file."
        >
          <Textarea value={rejections} onChange={(event) => setRejections(event.target.value)} />
        </Field>
        <Field label="Internal remarks" hint="Never shown to a customer.">
          <Textarea value={remarks} onChange={(event) => setRemarks(event.target.value)} />
        </Field>
        <Field label="Notes">
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() => {
              const result = organisationId
                ? updateInstitution(organisationId, build(), session.user.id)
                : createInstitution(build(), session.user.id);
              if (result.ok) {
                onSaved?.();
                onClose();
              }
              toast.show(
                result.ok ? `${name} saved.` : (result.message ?? "Could not save."),
                result.ok ? "good" : "bad",
              );
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function BranchForm({
  title,
  db,
  institutionOrganisationId,
  initial,
  onClose,
}: {
  title: string;
  db: Database;
  institutionOrganisationId: Id;
  initial?: BankBranch;
  onClose: () => void;
}): ReactNode {
  const session = useSession();
  const toast = useToast();
  const organisation = db.organisations.find((o) => o.id === initial?.organisationId);

  const [name, setName] = useState(organisation?.canonicalName ?? "");
  const [branchCode, setBranchCode] = useState(initial?.branchCode ?? "");
  const [districtId, setDistrictId] = useState(initial?.districtId ?? "");
  const [cityId, setCityId] = useState(initial?.cityId ?? "");
  const [addressLine, setAddressLine] = useState(initial?.addressLine ?? "");
  const [contactNumber, setContactNumber] = useState(initial?.contactNumber ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [status, setStatus] = useState<BranchStatus>(initial?.operationalStatus ?? "operational");
  const [notes, setNotes] = useState(initial?.notes ?? "");

  // Cities belong to districts (Database/migrations/0012), so choosing a
  // district narrows the city list rather than leaving somebody to scroll
  // past towns in another district.
  const cities = db.cities.filter(
    (city) => city.isActive && (districtId === "" || city.districtId === districtId),
  );

  const build = (): BranchInput => ({
    institutionOrganisationId,
    name,
    operationalStatus: status,
    ...(branchCode ? { branchCode } : {}),
    ...(districtId ? { districtId } : {}),
    ...(cityId ? { cityId } : {}),
    ...(addressLine ? { addressLine } : {}),
    ...(contactNumber ? { contactNumber } : {}),
    ...(email ? { email } : {}),
    ...(notes ? { notes } : {}),
  });

  return (
    <Modal open title={title} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Branch name" hint="How the office refers to it — the bank and the locality.">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Indian Bank — R.S. Puram"
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="District">
            <Select
              value={districtId}
              onChange={(event) => {
                setDistrictId(event.target.value);
                setCityId("");
              }}
            >
              <option value="">— Not stated —</option>
              {activeSorted(db.districts).map((district) => (
                <option key={district.id} value={district.id}>
                  {district.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="City or town">
            <Select value={cityId} onChange={(event) => setCityId(event.target.value)}>
              <option value="">— Not stated —</option>
              {cities
                .slice()
                .sort((a, b) => a.displayOrder - b.displayOrder)
                .map((city) => (
                  <option key={city.id} value={city.id}>
                    {city.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Is it open?">
            <Select
              value={status}
              onChange={(event) => setStatus(event.target.value as BranchStatus)}
            >
              <option value="operational">Open</option>
              <option value="temporarily_closed">Temporarily closed</option>
              <option value="closed">Closed for good</option>
            </Select>
          </Field>
        </div>

        <Field label="Address">
          <Textarea value={addressLine} onChange={(event) => setAddressLine(event.target.value)} />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Phone">
            <Input
              value={contactNumber}
              onChange={(event) => setContactNumber(event.target.value)}
            />
          </Field>
          <Field label="Email">
            <Input value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <Field label="Branch code" hint="The bank's own, if you have it.">
            <Input value={branchCode} onChange={(event) => setBranchCode(event.target.value)} />
          </Field>
        </div>

        <Field label="Notes">
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={name.trim().length === 0}
            onClick={() => {
              const result = initial
                ? updateBranch(initial.organisationId, build(), session.user.id)
                : createBranch(build(), session.user.id);
              if (result.ok) onClose();
              toast.show(
                result.ok ? "Branch saved." : (result.message ?? "Could not save."),
                result.ok ? "good" : "bad",
              );
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ContactForm({
  title,
  db,
  institutionOrganisationId,
  initial,
  onClose,
}: {
  title: string;
  db: Database;
  institutionOrganisationId: Id;
  initial?: BankContact;
  onClose: () => void;
}): ReactNode {
  const session = useSession();
  const toast = useToast();

  const [fullName, setFullName] = useState(
    initial ? contactLabelOrBlank(initial, db) : "",
  );
  const [branchOrganisationId, setBranchOrganisationId] = useState(
    initial?.branchOrganisationId ?? "",
  );
  const [relationshipRoleId, setRelationshipRoleId] = useState(initial?.relationshipRoleId ?? "");
  const [designation, setDesignation] = useState(initial?.designation ?? "");
  const [workMobile, setWorkMobile] = useState(initial?.workMobile ?? "");
  const [workEmail, setWorkEmail] = useState(initial?.workEmail ?? "");
  const [isPrimaryContact, setIsPrimaryContact] = useState(initial?.isPrimaryContact ?? false);
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const branches = db.organisations.filter(
    (org) => org.parentOrganisationId === institutionOrganisationId && org.roles.includes("branch"),
  );

  const build = (): RelationshipManagerInput => ({
    ...(fullName ? { fullName } : {}),
    institutionOrganisationId,
    ...(branchOrganisationId ? { branchOrganisationId } : {}),
    ...(relationshipRoleId ? { relationshipRoleId } : {}),
    ...(designation ? { designation } : {}),
    ...(workMobile ? { workMobile } : {}),
    ...(workEmail ? { workEmail } : {}),
    ...(isPrimaryContact ? { isPrimaryContact } : {}),
    ...(notes ? { notes } : {}),
  });

  return (
    <Modal open title={title} onClose={onClose}>
      <div className="space-y-4">
        <Field
          label="Name"
          hint="Optional. A shared mailbox — homeloans.cbe@bank.com — has no name, and that is a complete record rather than a partial one."
        >
          <Input value={fullName} onChange={(event) => setFullName(event.target.value)} />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Branch"
            hint="Leave blank for a regional or state-level manager — that is a complete record, not a missing one."
          >
            <Select
              value={branchOrganisationId}
              onChange={(event) => setBranchOrganisationId(event.target.value)}
            >
              <option value="">— No specific branch —</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.canonicalName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="What they do" hint="Managed under Master Data.">
            <Select
              value={relationshipRoleId}
              onChange={(event) => setRelationshipRoleId(event.target.value)}
            >
              <option value="">— Not stated —</option>
              {activeSorted(db.lenderRelationshipRoles).map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Their own job title" hint="Exactly as it appears on their card, if it differs.">
          <Input value={designation} onChange={(event) => setDesignation(event.target.value)} />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Work mobile">
            <Input value={workMobile} onChange={(event) => setWorkMobile(event.target.value)} />
          </Field>
          <Field
            label="Work email"
            hint="This is the address the Add Bank workflow offers when a file goes out."
          >
            <Input value={workEmail} onChange={(event) => setWorkEmail(event.target.value)} />
          </Field>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={isPrimaryContact}
            disabled={branchOrganisationId === ""}
            onChange={(event) => setIsPrimaryContact(event.target.checked)}
          />
          <span>
            Primary contact for this branch
            <span className="block text-xs text-ink-500">
              {branchOrganisationId === ""
                ? "Needs a branch — a primary contact is a branch's standing arrangement."
                : "Addressed first when a file goes to this branch. Setting this clears it from whoever holds it now."}
            </span>
          </span>
        </label>

        <Field
          label="Notes"
          hint="How they like to be worked with — when they answer, what they want first."
        >
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={fullName.trim().length === 0 && workEmail.trim().length === 0}
            onClick={() => {
              const result = initial
                ? updateRelationshipManager(initial.id, build(), session.user.id)
                : createRelationshipManager(build(), session.user.id);
              if (result.ok) onClose();
              toast.show(
                result.ok ? "Contact saved." : (result.message ?? "Could not save."),
                result.ok ? "good" : "bad",
              );
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function SubmissionRuleForm({
  db,
  organisation,
  onClose,
}: {
  db: Database;
  organisation: Organisation;
  onClose: () => void;
}): ReactNode {
  const session = useSession();
  const toast = useToast();

  const [organisationId, setOrganisationId] = useState<Id>(organisation.id);
  const [loanProductId, setLoanProductId] = useState<Id | "">("");
  const [submissionModeId, setSubmissionModeId] = useState<Id | "">("");
  const [portalUrl, setPortalUrl] = useState("");
  const [whatToCarry, setWhatToCarry] = useState("");
  const [loginFeeNotes, setLoginFeeNotes] = useState("");
  const [turnaroundNotes, setTurnaroundNotes] = useState("");
  const [notes, setNotes] = useState("");

  const branches = db.organisations.filter(
    (org) => org.parentOrganisationId === organisation.id && org.roles.includes("branch"),
  );

  const build = (): SubmissionRuleInput => ({
    organisationId,
    ...(loanProductId ? { loanProductId } : {}),
    ...(submissionModeId ? { submissionModeId } : {}),
    ...(portalUrl ? { portalUrl } : {}),
    ...(whatToCarry ? { whatToCarry } : {}),
    ...(loginFeeNotes ? { loginFeeNotes } : {}),
    ...(turnaroundNotes ? { turnaroundNotes } : {}),
    ...(notes ? { notes } : {}),
  });

  return (
    <Modal open title="Add a submission note" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-ink-500">
          Notes for whoever lodges the next file. AOS does not act on these — the submission
          workflow is a later milestone.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Applies to" hint="The whole lender, or one branch that differs.">
            <Select
              value={organisationId}
              onChange={(event) => setOrganisationId(event.target.value)}
            >
              <option value={organisation.id}>{organisation.canonicalName} (everywhere)</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.canonicalName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="For which product" hint="Leave as All unless this note is product-specific.">
            <Select
              value={loanProductId}
              onChange={(event) => setLoanProductId(event.target.value)}
            >
              <option value="">All products</option>
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
          </Field>
        </div>

        <Field label="How it goes in" hint="Managed under Master Data.">
          <Select
            value={submissionModeId}
            onChange={(event) => setSubmissionModeId(event.target.value)}
          >
            <option value="">— Not stated —</option>
            {activeSorted(db.submissionModes).map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Portal link">
          <Input value={portalUrl} onChange={(event) => setPortalUrl(event.target.value)} />
        </Field>
        <Field label="What to carry">
          <Textarea value={whatToCarry} onChange={(event) => setWhatToCarry(event.target.value)} />
        </Field>
        <Field label="Login fee">
          <Input
            value={loginFeeNotes}
            onChange={(event) => setLoginFeeNotes(event.target.value)}
            placeholder="e.g. Collected at login, cheque in favour of the branch"
          />
        </Field>
        <Field label="What usually comes back, and when">
          <Textarea
            value={turnaroundNotes}
            onChange={(event) => setTurnaroundNotes(event.target.value)}
          />
        </Field>
        <Field label="Anything else">
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              const result = createSubmissionRule(build(), session.user.id);
              if (result.ok) onClose();
              toast.show(
                result.ok ? "Saved." : (result.message ?? "Could not save."),
                result.ok ? "good" : "bad",
              );
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function InsightForm({
  db,
  organisation,
  onClose,
}: {
  db: Database;
  organisation: Organisation;
  onClose: () => void;
}): ReactNode {
  const session = useSession();
  const toast = useToast();

  const [organisationId, setOrganisationId] = useState<Id>(organisation.id);
  const [categoryId, setCategoryId] = useState<Id | "">("");
  const [body, setBody] = useState("");
  const [loanProductId, setLoanProductId] = useState<Id | "">("");
  const [observedOn, setObservedOn] = useState(today());

  const branches = db.organisations.filter(
    (org) => org.parentOrganisationId === organisation.id && org.roles.includes("branch"),
  );

  const build = (): LenderInsightInput => ({
    organisationId,
    lenderInsightCategoryId: categoryId,
    body,
    ...(loanProductId ? { loanProductId } : {}),
    ...(observedOn ? { observedOn } : {}),
  });

  return (
    <Modal open title="Add what we know" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-ink-500">
          Your own experience of working with this lender, in your own words. It is guidance for
          the next person, not a rule — nothing in AOS decides anything from it.
        </p>

        <Field label="What kind of note is this?" hint="Managed under Master Data.">
          <Select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
            <option value="">— Choose —</option>
            {activeSorted(db.lenderInsightCategories).map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="The note">
          <Textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="e.g. Very good with textile units in Tiruppur. Asks for an extra year of ITR on anything above 50 lakh."
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="About" hint="The whole lender, or one branch.">
            <Select
              value={organisationId}
              onChange={(event) => setOrganisationId(event.target.value)}
            >
              <option value={organisation.id}>{organisation.canonicalName}</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.canonicalName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="For which product" hint="Optional.">
            <Select
              value={loanProductId}
              onChange={(event) => setLoanProductId(event.target.value)}
            >
              <option value="">Any product</option>
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
          </Field>
          <Field label="When was this true?" hint="A note nobody has checked in two years is worth discounting.">
            <Input
              type="date"
              value={observedOn}
              onChange={(event) => setObservedOn(event.target.value)}
            />
          </Field>
        </div>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={body.trim().length === 0 || categoryId === ""}
            onClick={() => {
              const result = addLenderInsight(build(), session.user.id);
              if (result.ok) onClose();
              toast.show(
                result.ok ? "Saved." : (result.message ?? "Could not save."),
                result.ok ? "good" : "bad",
              );
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
