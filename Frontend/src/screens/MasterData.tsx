/**
 * Master Data administration (Milestone 5, refined in Milestone 6).
 *
 * One consistent experience for every controlled-vocabulary table in AOS —
 * searchable, fast, and built for office staff rather than engineers. Every
 * section shares the same shape (code, name, description, active, order,
 * notes) because that consistency is what makes the screen learnable in one
 * sitting (Milestone brief: "The UI should be simple. Searchable. Fast.
 * Non-technical.").
 *
 * Records are deactivated, never deleted — the same convention as
 * rejection_reason and document_type, so a value already used on a live
 * record never disappears out from under it.
 *
 * Milestone 6 groups every section into three categories (ADR-031):
 *
 *   System      — rarely changes, administrator-level reference data.
 *   Business    — business-controlled, defines Amaze's lending ecosystem.
 *   Operational — frequently-changing entities: people and firms Amaze
 *                 works with day to day. None are implemented as editable
 *                 master data yet — they are richer entities than a
 *                 code/name row (a Relationship Manager is a person with a
 *                 branch relationship, not vocabulary), so each is either
 *                 already modelled elsewhere or awaits its own milestone.
 *                 Listed here so office staff can see where it will live.
 *
 * The category is a display grouping only, defined per section below — the
 * same "documentation grouping, no behaviour" pattern
 * src/domain/permissions/actions.ts uses for PERMISSION_GROUPS. It has no
 * schema representation; introducing one would be exactly the kind of
 * unrequested structural change this milestone's brief rules out.
 *
 * Deliberately absent as editable sections: Banks / NBFCs / HFCs / Branches
 * (already organisation rows, ADR-014/015 — their own screen is the
 * "Coimbatore Bank & NBFC Catalogue" milestone), and lending products
 * themselves, which since Milestone 7 have their own screen (Products in the
 * top bar, ADR-032) because a product is far richer than a code/name row.
 * The vocabulary that screen is built from — Customer Product, Borrower Type,
 * Security Type, Requirement Applicability — is managed here, which is the
 * division this screen has always drawn.
 */

import { useMemo, useState, type ReactNode } from "react";

import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_LABELS,
  type DocumentCategory,
} from "@domain/requirements/document-catalogue.js";

import { api } from "../api/client.js";
import { useMutation } from "../api/hooks.js";
import { useDocumentTypes, useRejectionReasons, useThresholds } from "../api/master-data.js";
import type { ApiDocumentType, ApiRejectionReason, ApiThreshold } from "../api/types.js";
import { MASTER_DATA_LABELS, type MasterDataKind } from "../fake/store.js";
import { useDatabase } from "../fake/useDatabase.js";
import type { MasterDataRecord } from "../fake/types.js";
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
  cx,
  useToast,
} from "../ui/index.js";

type MasterDataCategory = "system" | "business" | "operational";

const CATEGORY_ORDER: readonly MasterDataCategory[] = ["system", "business", "operational"];

const CATEGORY_LABELS: Record<MasterDataCategory, string> = {
  system: "System Master Data",
  business: "Business Master Data",
  operational: "Operational Master Data",
};

const CATEGORY_HINTS: Record<MasterDataCategory, string> = {
  system: "Rarely changes. Administrator-level reference data.",
  business: "Business controlled. Defines Amaze's lending ecosystem. Changes occasionally.",
  operational: "Frequently changing — the people and firms Amaze works with day to day.",
};

interface SimpleSection {
  kind: "simple";
  key: MasterDataKind;
  label: string;
  hint: string;
  category: MasterDataCategory;
}

interface DocumentTypeSection {
  kind: "documentType";
  label: string;
  hint: string;
  category: MasterDataCategory;
}

interface RejectionReasonSection {
  kind: "rejectionReason";
  label: string;
  hint: string;
  category: MasterDataCategory;
}

interface ThresholdSection {
  kind: "threshold";
  label: string;
  hint: string;
  category: MasterDataCategory;
}

type Section = SimpleSection | DocumentTypeSection | RejectionReasonSection | ThresholdSection;

const SECTIONS: Section[] = [
  // System — rarely changes, administrator-level reference data.
  { kind: "documentType", label: "Document Types", hint: "The kinds of document AOS recognises. Requirement templates key off these.", category: "system" },
  { kind: "simple", key: "employmentTypes", label: "Employment Types", hint: "A person's income-source classification. Drives which income documents a case asks for.", category: "system" },
  { kind: "simple", key: "businessConstitutions", label: "Business Constitutions", hint: "How a borrowing firm is legally constituted — proprietorship, partnership, private limited.", category: "system" },
  { kind: "simple", key: "propertyTypes", label: "Property Types", hint: "Apartment, independent house, plot, villa, commercial, agricultural.", category: "system" },
  { kind: "simple", key: "propertyOwnershipTypes", label: "Property Ownership Types", hint: "How title is held — freehold, leasehold, ancestral, power of attorney.", category: "system" },
  { kind: "rejectionReason", label: "Rejection Reasons", hint: "Amaze's standardised categories for why a bank declined a case (ADR-028).", category: "system" },
  { kind: "threshold", label: "Thresholds", hint: "How many days a case may sit before it needs attention (ADR-025). The set of thresholds is fixed in code; only the values are editable here.", category: "system" },
  { kind: "simple", key: "districts", label: "Districts", hint: "Districts Amaze operates in or lends against.", category: "system" },
  { kind: "simple", key: "cities", label: "Cities", hint: "Cities Amaze operates in or lends against, each within a district.", category: "system" },
  { kind: "simple", key: "requirementApplicabilities", label: "Requirement Applicability", hint: "Mandatory, optional, not applicable. Used wherever a product says how strongly it needs something.", category: "system" },

  // Business — business-controlled, defines Amaze's lending ecosystem.
  { kind: "simple", key: "customerProducts", label: "Customer Products", hint: "What a telecaller thinks of first — Home Loan, Business Loan, LAP — grouping the lending products underneath it.", category: "business" },
  { kind: "simple", key: "borrowerTypes", label: "Borrower Types", hint: "Who can borrow — resident individual, NRI, or a firm in its own name.", category: "business" },
  { kind: "simple", key: "securityTypes", label: "Security Types", hint: "What secures a lending product — a mortgage, pledged gold, hypothecated stock, a guarantee.", category: "business" },
  { kind: "simple", key: "referralSources", label: "Referral Sources", hint: "How a lead reached Amaze. Populates the Source field on case creation.", category: "business" },
  // Bank & NBFC Catalogue (Milestone 8) — Database/migrations/0019.
  { kind: "simple", key: "lenderTypes", label: "Lender Types", hint: "Public Sector Bank, NBFC, Housing Finance Company and the rest. Add a kind here and it appears on the Lenders screen without a deploy.", category: "business" },
  { kind: "simple", key: "lenderRelationshipRoles", label: "Relationship Roles", hint: "What a person at a lender does for us — Relationship Manager, Credit Manager, Branch Manager.", category: "operational" },
  { kind: "simple", key: "submissionModes", label: "Submission Modes", hint: "How a file reaches a lender — at the branch, by email, through their portal. Reference only; nothing acts on it.", category: "operational" },
  { kind: "simple", key: "lenderInsightCategories", label: "Lender Note Categories", hint: "How a note about a lender is filed — a strength, a limitation, a documentation habit. Guidance, never a rule.", category: "operational" },
];

interface PlannedEntity {
  name: string;
  note: string;
}

/**
 * Business and Operational Master Data whose vocabulary already has a home
 * in the schema but no editable section on this screen yet — either because
 * the screen is a later, named milestone, or because the entity is richer
 * than a code/name row and needs its own design. Read-only, so the
 * hierarchy is visible without building something nobody asked for yet.
 */
const PLANNED_BY_CATEGORY: Record<MasterDataCategory, PlannedEntity[]> = {
  system: [],
  business: [
    { name: "Lending Products", note: "Has its own screen — Products in the top bar (Milestone 7, ADR-032). The vocabulary it is built from is managed here." },
    { name: "Banks, NBFCs and Housing Finance Companies", note: "Have their own screen — Lenders in the top bar (Milestone 8, ADR-034). Organisation rows holding the lender role (ADR-014); the kinds of lender are managed here." },
    { name: "Bank Branches", note: "On the Lenders screen, under each lender. Organisation rows holding the branch role, plus the operational facts a branch has (ADR-015, Milestone 8)." },
  ],
  operational: [
    { name: "Employees", note: "Modelled today as app_user + person." },
    { name: "Relationship Managers", note: "On the Lenders screen, under each lender. A person plus a relationship, not vocabulary — so a manager who moves banks is a new relationship, never a lost contact (Milestone 8)." },
    { name: "Builders", note: "Modelled as organisation rows holding the builder role." },
    { name: "Developers", note: "Modelled as organisation rows holding the developer role." },
    { name: "Advocates", note: "Not yet modelled." },
    { name: "Legal Firms", note: "Not yet modelled." },
    { name: "Chartered Accountants", note: "Not yet modelled." },
    { name: "Valuers", note: "Not yet modelled." },
    { name: "DSAs", note: "Not yet modelled." },
    { name: "Referral Partners", note: "Distinct from referral_source (a channel) — a specific person or firm being paid, to be designed." },
  ],
};

export function MasterData(): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const [categoryKey, setCategoryKey] = useState<MasterDataCategory>("system");
  const [activeLabel, setActiveLabel] = useState<string>(SECTIONS[0]?.label ?? "");

  const canManage = session.can("master_data.manage", "all");

  if (!session.can("master_data.read", "all")) {
    return (
      <Card title="Not permitted">
        <p className="text-sm text-ink-700">
          This user does not hold <code>master_data.read</code>.
        </p>
      </Card>
    );
  }

  const sectionsInCategory = SECTIONS.filter((s) => s.category === categoryKey);
  const section = sectionsInCategory.find((s) => s.label === activeLabel) ?? sectionsInCategory[0];
  const planned = PLANNED_BY_CATEGORY[categoryKey];

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Master Data</h1>
        <p className="mt-1 text-sm text-ink-500">
          AOS's operational vocabulary.
          {section?.kind === "simple"
            ? " Read-only reference — see the note below."
            : !canManage && " This user can view but not edit — hold master_data.manage to change values."}
        </p>
        {section?.kind === "simple" && <NotConnectedBanner />}
      </div>

      <div className="flex gap-1 border-b border-ink-200">
        {CATEGORY_ORDER.map((category) => (
          <button
            key={category}
            onClick={() => {
              setCategoryKey(category);
              const first = SECTIONS.find((s) => s.category === category);
              setActiveLabel(first?.label ?? "");
            }}
            className={cx(
              "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              category === categoryKey
                ? "border-brand-600 text-ink-900"
                : "border-transparent text-ink-500 hover:text-ink-700",
            )}
          >
            {CATEGORY_LABELS[category]}
          </button>
        ))}
      </div>
      <p className="-mt-2 text-xs text-ink-500">{CATEGORY_HINTS[categoryKey]}</p>

      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        <nav className="space-y-3">
          {sectionsInCategory.length > 0 && (
            <div className="space-y-0.5">
              {sectionsInCategory.map((s) => (
                <button
                  key={s.label}
                  onClick={() => setActiveLabel(s.label)}
                  className={cx(
                    "block w-full rounded-md px-3 py-1.5 text-left text-sm font-medium",
                    s.label === section?.label
                      ? "bg-brand-100 text-brand-900"
                      : "text-ink-700 hover:bg-ink-50",
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}

          {planned.length > 0 && (
            <div className="rounded-md bg-ink-50 p-3">
              <p className="text-xs font-medium text-ink-700">
                Also {CATEGORY_LABELS[categoryKey].toLowerCase()}, not yet editable here:
              </p>
              <ul className="mt-1.5 space-y-1.5">
                {planned.map((p) => (
                  <li key={p.name} className="text-xs text-ink-500">
                    <span className="font-medium text-ink-700">{p.name}</span> — {p.note}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </nav>

        {section?.kind === "simple" && <SimpleMasterDataSection section={section} db={db} />}
        {section?.kind === "documentType" && (
          <DocumentTypeSectionView section={section} canManage={canManage} />
        )}
        {section?.kind === "rejectionReason" && (
          <RejectionReasonSectionView section={section} canManage={canManage} />
        )}
        {section?.kind === "threshold" && (
          <ThresholdSectionView section={section} canManage={canManage} />
        )}
        {!section && (
          <Card title={CATEGORY_LABELS[categoryKey]} subtitle={CATEGORY_HINTS[categoryKey]}>
            <p className="text-sm text-ink-700">
              Nothing in this category is editable here yet — see the list on the left for where
              each one already lives, and which milestone gives it its own screen.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search — shared by every section
// ---------------------------------------------------------------------------

function useSearch<T extends { code: string; name: string; description?: string }>(
  records: readonly T[],
): [string, (value: string) => void, T[]] {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [...records];
    return records.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.code.toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q),
    );
  }, [records, query]);
  return [query, setQuery, filtered];
}

// ---------------------------------------------------------------------------
// The generic section — everything sharing MasterDataRecord's shape
// ---------------------------------------------------------------------------

/**
 * Read-only reference browsing (Production Readiness Phase 2, "Admin-screen
 * honesty"). This section still reads `Frontend/src/fake/store.ts` — a
 * per-browser prototype dataset, not the office database — so it no longer
 * offers Add/Edit/Deactivate: those wrote to localStorage only, invisible to
 * every other PC and to real cases. See the banner above.
 */
function SimpleMasterDataSection({
  section,
  db,
}: {
  section: SimpleSection;
  db: ReturnType<typeof useDatabase>;
}): ReactNode {
  const records = (db[section.key] as readonly MasterDataRecord[])
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder);
  const [query, setQuery, filtered] = useSearch(records);

  const showState = section.key === "districts";

  return (
    <Card title={MASTER_DATA_LABELS[section.key] + "s"} subtitle={section.hint}>
      <div className="space-y-3">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${section.label.toLowerCase()}…`}
        />

        {filtered.length === 0 ? (
          <Empty>Nothing matches.</Empty>
        ) : (
          <ul className="divide-y divide-ink-100">
            {filtered.map((record) => (
              <li key={record.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {record.name}
                    {!record.isActive && <Badge tone="neutral">Inactive</Badge>}
                    {section.key === "cities" && record.districtId && (
                      <span className="text-xs font-normal text-ink-500">
                        {db.districts.find((d) => d.id === record.districtId)?.name}
                      </span>
                    )}
                    {showState && record.state && (
                      <span className="text-xs font-normal text-ink-500">{record.state}</span>
                    )}
                  </p>
                  <p className="tnum text-xs text-ink-500">
                    {record.code}
                    {record.description && ` · ${record.description}`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Document types — extra fields (ownerKind, requiresPeriod, requiresExpiry)
// are shown read-only. Milestone 5 gives them name/description/active
// management; changing what kind of thing a document type belongs to is a
// structural decision the requirement engine depends on, not a data edit.
// ---------------------------------------------------------------------------

function DocumentTypeSectionView({
  section,
  canManage,
}: {
  section: DocumentTypeSection;
  canManage: boolean;
}): ReactNode {
  const toast = useToast();
  const mutation = useMutation();
  const [editing, setEditing] = useState<ApiDocumentType | null>(null);

  const typesQuery = useDocumentTypes();
  const records = typesQuery.documentTypes.slice().sort((a, b) => a.displayOrder - b.displayOrder);
  const [query, setQuery, filtered] = useSearch(records);

  return (
    <Card title="Document Types" subtitle={section.hint}>
      <div className="space-y-3">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search document types…" />

        {typesQuery.loading ? (
          <Empty>Loading…</Empty>
        ) : filtered.length === 0 ? (
          <Empty>Nothing matches.</Empty>
        ) : (
          <ul className="divide-y divide-ink-100">
            {filtered.map((type) => (
              <li key={type.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {type.name}
                    {type.localName && (
                      <span className="text-xs font-normal text-ink-400">({type.localName})</span>
                    )}
                    {!type.isActive && <Badge tone="neutral">Inactive</Badge>}
                    {type.category && (
                      <Badge>{DOCUMENT_CATEGORY_LABELS[type.category]}</Badge>
                    )}
                    <Badge tone="info">{type.ownerKind}</Badge>
                    {type.requiresPeriod && <Badge tone="warn">Period</Badge>}
                    {type.requiresExpiry && <Badge tone="warn">Expiry</Badge>}
                  </p>
                  <p className="tnum text-xs text-ink-500">
                    {type.code}
                    {type.periodKind === "assessment_year" && " · by assessment year"}
                    {type.periodKind === "financial_year" && " · by financial year"}
                    {type.description && ` · ${type.description}`}
                  </p>
                  {type.examples && type.examples.length > 0 && (
                    <p className="text-xs text-ink-400">
                      Examples: {type.examples.join(", ")}
                    </p>
                  )}
                </div>
                {canManage && (
                  <div className="flex shrink-0 items-center gap-2">
                    <Button onClick={() => setEditing(type)}>Edit</Button>
                    <Button
                      variant={type.isActive ? "secondary" : "primary"}
                      disabled={mutation.pending}
                      onClick={async () => {
                        const result = await mutation.run(() =>
                          api(`/master-data/document-types/${type.id}/active`, {
                            method: "PUT",
                            body: { isActive: !type.isActive },
                          }),
                        );
                        if (result === undefined) {
                          toast.show(mutation.error ?? "Could not update.", "bad");
                          return;
                        }
                        toast.show(`${type.name} ${type.isActive ? "deactivated" : "reactivated"}.`);
                        typesQuery.refetch();
                      }}
                    >
                      {type.isActive ? "Deactivate" : "Reactivate"}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {editing && (
        <DocumentTypeModal
          type={editing}
          onClose={() => setEditing(null)}
          onSubmit={async (patch) => {
            const result = await mutation.run(() =>
              api(`/master-data/document-types/${editing.id}`, { method: "PUT", body: patch }),
            );
            if (result === undefined) {
              toast.show(mutation.error ?? "Could not update.", "bad");
              return;
            }
            setEditing(null);
            toast.show("Document type updated.");
            typesQuery.refetch();
          }}
        />
      )}
    </Card>
  );
}

/**
 * Editing what a document is CALLED and how it is EXPLAINED.
 *
 * Four fields, and all four exist for the person on the phone: the official
 * name a bank will recognise, the local name a customer will recognise, one
 * sentence explaining it, and which block of the checklist it belongs in.
 * A separate modal from the generic name-and-description one because a
 * document type is the one piece of master data where the wording is the
 * feature (Telecaller Workflow milestone).
 */
function DocumentTypeModal({
  type,
  onClose,
  onSubmit,
}: {
  type: ApiDocumentType;
  onClose: () => void;
  onSubmit: (patch: {
    name: string;
    localName: string;
    description: string;
    examples: string[];
    category: DocumentCategory;
  }) => void;
}): ReactNode {
  const [name, setName] = useState(type.name);
  const [localName, setLocalName] = useState(type.localName ?? "");
  const [description, setDescription] = useState(type.description ?? "");
  const [examples, setExamples] = useState((type.examples ?? []).join(", "));
  const [category, setCategory] = useState<DocumentCategory>(type.category ?? "additional");

  return (
    <Modal open title="Edit Document Type" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name" hint="What we call it to the customer.">
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field
          label="Common local name"
          hint='Optional. What it is called locally — "Villangam Certificate", "GST 3B", "Udyog Aadhaar". Shown beside the official name, never instead of it.'
        >
          <Input value={localName} onChange={(event) => setLocalName(event.target.value)} />
        </Field>
        <Field
          label="Description"
          hint="One sentence somebody in their first week could read out to a customer."
        >
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <Field
          label="Examples"
          hint='Optional, comma separated. Use where the honest answer is a list rather than a sentence — "EB Bill, Gas Bill, Ration Card, Passport, Driving Licence".'
        >
          <Input
            value={examples}
            onChange={(event) => setExamples(event.target.value)}
            placeholder="EB Bill, Gas Bill, Ration Card"
          />
        </Field>
        <Field label="Category" hint="Which section of the collection call this appears in.">
          <Select
            value={category}
            onChange={(event) => setCategory(event.target.value as DocumentCategory)}
          >
            {DOCUMENT_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {DOCUMENT_CATEGORY_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Back
          </Button>
          <Button
            variant="primary"
            onClick={() =>
              onSubmit({
                name,
                localName,
                description,
                examples: examples.split(",").map((e) => e.trim()).filter(Boolean),
                category,
              })
            }
          >
            Save &amp; continue
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Rejection reasons — ADR-028. Same treatment as document types.
// ---------------------------------------------------------------------------

function RejectionReasonSectionView({
  section,
  canManage,
}: {
  section: RejectionReasonSection;
  canManage: boolean;
}): ReactNode {
  const toast = useToast();
  const mutation = useMutation();
  const [editing, setEditing] = useState<ApiRejectionReason | null>(null);

  const reasonsQuery = useRejectionReasons();
  const records = reasonsQuery.rejectionReasons.slice().sort((a, b) => a.displayOrder - b.displayOrder);
  const [query, setQuery, filtered] = useSearch(records);

  return (
    <Card title="Rejection Reasons" subtitle={section.hint}>
      <div className="space-y-3">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search rejection reasons…" />

        {reasonsQuery.loading ? (
          <Empty>Loading…</Empty>
        ) : filtered.length === 0 ? (
          <Empty>Nothing matches.</Empty>
        ) : (
          <ul className="divide-y divide-ink-100">
            {filtered.map((reason) => (
              <li key={reason.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {reason.name}
                    {!reason.isActive && <Badge tone="neutral">Inactive</Badge>}
                  </p>
                  <p className="tnum text-xs text-ink-500">
                    {reason.code}
                    {reason.description && ` · ${reason.description}`}
                  </p>
                </div>
                {canManage && (
                  <div className="flex shrink-0 items-center gap-2">
                    <Button onClick={() => setEditing(reason)}>Edit</Button>
                    <Button
                      variant={reason.isActive ? "secondary" : "primary"}
                      disabled={mutation.pending}
                      onClick={async () => {
                        const result = await mutation.run(() =>
                          api(`/master-data/rejection-reasons/${reason.id}/active`, {
                            method: "PUT",
                            body: { isActive: !reason.isActive },
                          }),
                        );
                        if (result === undefined) {
                          toast.show(mutation.error ?? "Could not update.", "bad");
                          return;
                        }
                        toast.show(`${reason.name} ${reason.isActive ? "deactivated" : "reactivated"}.`);
                        reasonsQuery.refetch();
                      }}
                    >
                      {reason.isActive ? "Deactivate" : "Reactivate"}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {editing && (
        <NameDescriptionModal
          title="Edit Rejection Reason"
          name={editing.name}
          description={editing.description ?? ""}
          onClose={() => setEditing(null)}
          onSubmit={async (patch) => {
            const result = await mutation.run(() =>
              api(`/master-data/rejection-reasons/${editing.id}`, { method: "PUT", body: patch }),
            );
            if (result === undefined) {
              toast.show(mutation.error ?? "Could not update.", "bad");
              return;
            }
            setEditing(null);
            toast.show("Rejection reason updated.");
            reasonsQuery.refetch();
          }}
        />
      )}
    </Card>
  );
}

function NameDescriptionModal({
  title,
  name: initialName,
  description: initialDescription,
  onClose,
  onSubmit,
}: {
  title: string;
  name: string;
  description: string;
  onClose: () => void;
  onSubmit: (patch: { name: string; description?: string }) => void;
}): ReactNode {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);

  return (
    <Modal open title={title} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Display name">
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={name.trim().length === 0}
            onClick={() => onSubmit({ name, ...(description ? { description } : {}) })}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Thresholds (ADR-025) — the tunable day-counts. The key set is a closed
// enum fixed in @domain/settings/thresholds.ts; only the value is edited
// here, one row at a time, since there is nothing to search or add.
// ---------------------------------------------------------------------------

function ThresholdSectionView({
  section,
  canManage,
}: {
  section: ThresholdSection;
  canManage: boolean;
}): ReactNode {
  const toast = useToast();
  const mutation = useMutation();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState("");

  const thresholdsQuery = useThresholds();
  const thresholds = thresholdsQuery.thresholds.slice().sort((a, b) => a.key.localeCompare(b.key));

  return (
    <Card title="Thresholds" subtitle={section.hint}>
      {thresholdsQuery.loading ? (
        <Empty>Loading…</Empty>
      ) : thresholds.length === 0 ? (
        <Empty>No thresholds configured.</Empty>
      ) : (
        <ul className="divide-y divide-ink-100">
          {thresholds.map((threshold: ApiThreshold) => (
            <li key={threshold.key} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{threshold.description ?? threshold.key}</p>
                <p className="tnum text-xs text-ink-500">{threshold.key}</p>
              </div>
              {editingKey === threshold.key ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    value={draftValue}
                    onChange={(event) => setDraftValue(event.target.value)}
                    className="w-20"
                  />
                  <span className="text-xs text-ink-500">days</span>
                  <Button
                    variant="primary"
                    disabled={mutation.pending}
                    onClick={async () => {
                      const valueDays = Number(draftValue);
                      if (!Number.isInteger(valueDays) || valueDays <= 0) {
                        toast.show("Enter a positive whole number of days.", "bad");
                        return;
                      }
                      const result = await mutation.run(() =>
                        api(`/master-data/thresholds/${encodeURIComponent(threshold.key)}`, {
                          method: "PUT",
                          body: { valueDays },
                        }),
                      );
                      if (result === undefined) {
                        toast.show(mutation.error ?? "Could not update.", "bad");
                        return;
                      }
                      toast.show("Threshold updated.");
                      setEditingKey(null);
                      thresholdsQuery.refetch();
                    }}
                  >
                    Save
                  </Button>
                  <Button variant="ghost" onClick={() => setEditingKey(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex shrink-0 items-center gap-2">
                  <span className="tnum text-sm font-medium">{threshold.valueDays} days</span>
                  {canManage && (
                    <Button
                      onClick={() => {
                        setEditingKey(threshold.key);
                        setDraftValue(String(threshold.valueDays));
                      }}
                    >
                      Edit
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
