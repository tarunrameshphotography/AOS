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
 * The vocabulary that screen is built from — Loan Category, Borrower Type,
 * Security Type, Requirement Applicability — is managed here, which is the
 * division this screen has always drawn.
 */

import { useMemo, useState, type ReactNode } from "react";

import {
  createMasterDataRecord,
  MASTER_DATA_LABELS,
  setDocumentTypeActive,
  setMasterDataActive,
  setRejectionReasonActive,
  updateDocumentTypeDetails,
  updateMasterDataRecord,
  updateRejectionReasonDetails,
  type MasterDataInput,
  type MasterDataKind,
} from "../fake/store.js";
import { useDatabase } from "../fake/useDatabase.js";
import type { DocumentType, Id, MasterDataRecord, RejectionReason } from "../fake/types.js";
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

type Section = SimpleSection | DocumentTypeSection | RejectionReasonSection;

const SECTIONS: Section[] = [
  // System — rarely changes, administrator-level reference data.
  { kind: "documentType", label: "Document Types", hint: "The kinds of document AOS recognises. Requirement templates key off these.", category: "system" },
  { kind: "simple", key: "employmentTypes", label: "Employment Types", hint: "A person's income-source classification. Drives which income documents a case asks for.", category: "system" },
  { kind: "simple", key: "businessConstitutions", label: "Business Constitutions", hint: "How a borrowing firm is legally constituted — proprietorship, partnership, private limited.", category: "system" },
  { kind: "simple", key: "propertyTypes", label: "Property Types", hint: "Apartment, independent house, plot, villa, commercial, agricultural.", category: "system" },
  { kind: "simple", key: "propertyOwnershipTypes", label: "Property Ownership Types", hint: "How title is held — freehold, leasehold, ancestral, power of attorney.", category: "system" },
  { kind: "rejectionReason", label: "Rejection Reasons", hint: "Amaze's standardised categories for why a bank declined a case (ADR-028).", category: "system" },
  { kind: "simple", key: "districts", label: "Districts", hint: "Districts Amaze operates in or lends against.", category: "system" },
  { kind: "simple", key: "cities", label: "Cities", hint: "Cities Amaze operates in or lends against, each within a district.", category: "system" },
  { kind: "simple", key: "requirementApplicabilities", label: "Requirement Applicability", hint: "Mandatory, optional, not applicable. Used wherever a product says how strongly it needs something.", category: "system" },

  // Business — business-controlled, defines Amaze's lending ecosystem.
  { kind: "simple", key: "loanCategories", label: "Loan Categories", hint: "The commercial grouping lending products hang off — Home Loan, Business Loan, LAP.", category: "business" },
  { kind: "simple", key: "borrowerTypes", label: "Borrower Types", hint: "Who can borrow — resident individual, NRI, or a firm in its own name.", category: "business" },
  { kind: "simple", key: "securityTypes", label: "Security Types", hint: "What secures a lending product — a mortgage, pledged gold, hypothecated stock, a guarantee.", category: "business" },
  { kind: "simple", key: "referralSources", label: "Referral Sources", hint: "How a lead reached Amaze. Populates the Source field on case creation.", category: "business" },
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
    { name: "Banks", note: "Organisation rows holding the lender role (ADR-014). Own screen: \"Coimbatore Bank & NBFC Catalogue\" milestone." },
    { name: "NBFCs", note: "Organisation rows, lender_profile.lender_type = 'nbfc'. Same upcoming screen as Banks." },
    { name: "Housing Finance Companies", note: "Organisation rows, lender_profile.lender_type = 'hfc'. Same upcoming screen as Banks." },
    { name: "Bank Branches", note: "Organisation rows holding the branch role (ADR-015). Same upcoming screen as Banks." },
  ],
  operational: [
    { name: "Employees", note: "Modelled today as app_user + person." },
    { name: "Relationship Managers", note: "Modelled today as person + bank_contact — a relationship, not vocabulary." },
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
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Master Data</h1>
        <p className="mt-1 text-sm text-ink-500">
          The operational vocabulary of AOS. Add a value here and it is immediately available
          everywhere it is used — no deploy, no code change.
          {!canManage && " This user can view but not edit — hold master_data.manage to change values."}
        </p>
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

        {section?.kind === "simple" && (
          <SimpleMasterDataSection section={section} db={db} canManage={canManage} />
        )}
        {section?.kind === "documentType" && (
          <DocumentTypeSectionView section={section} db={db} canManage={canManage} />
        )}
        {section?.kind === "rejectionReason" && (
          <RejectionReasonSectionView section={section} db={db} canManage={canManage} />
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

function SimpleMasterDataSection({
  section,
  db,
  canManage,
}: {
  section: SimpleSection;
  db: ReturnType<typeof useDatabase>;
  canManage: boolean;
}): ReactNode {
  const session = useSession();
  const toast = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<MasterDataRecord | null>(null);

  const records = (db[section.key] as readonly MasterDataRecord[])
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder);
  const [query, setQuery, filtered] = useSearch(records);

  const districtOptions = section.key === "cities" ? db.districts : undefined;
  const showState = section.key === "districts";

  return (
    <Card
      title={MASTER_DATA_LABELS[section.key] + "s"}
      subtitle={section.hint}
      actions={canManage && <Button variant="primary" onClick={() => setAddOpen(true)}>Add</Button>}
    >
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
                {canManage && (
                  <div className="flex shrink-0 items-center gap-2">
                    <Button onClick={() => setEditing(record)}>Edit</Button>
                    <Button
                      variant={record.isActive ? "secondary" : "primary"}
                      onClick={() => {
                        const result = setMasterDataActive(
                          section.key,
                          record.id,
                          !record.isActive,
                          session.user.id,
                        );
                        toast.show(
                          result.ok
                            ? `${record.name} ${record.isActive ? "deactivated" : "reactivated"}.`
                            : (result.message ?? "Could not update."),
                          result.ok ? "good" : "bad",
                        );
                      }}
                    >
                      {record.isActive ? "Deactivate" : "Reactivate"}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {addOpen && (
        <MasterDataForm
          title={`Add ${MASTER_DATA_LABELS[section.key]}`}
          districtOptions={districtOptions}
          showState={showState}
          onClose={() => setAddOpen(false)}
          onSubmit={(input) => {
            const result = createMasterDataRecord(section.key, input, session.user.id);
            if (result.ok) setAddOpen(false);
            toast.show(
              result.ok ? `${input.name} added.` : (result.message ?? "Could not add."),
              result.ok ? "good" : "bad",
            );
          }}
        />
      )}

      {editing && (
        <MasterDataForm
          title={`Edit ${MASTER_DATA_LABELS[section.key]}`}
          initial={editing}
          districtOptions={districtOptions}
          showState={showState}
          onClose={() => setEditing(null)}
          onSubmit={(input) => {
            const result = updateMasterDataRecord(section.key, editing.id, input, session.user.id);
            if (result.ok) setEditing(null);
            toast.show(
              result.ok ? `${input.name} updated.` : (result.message ?? "Could not update."),
              result.ok ? "good" : "bad",
            );
          }}
        />
      )}
    </Card>
  );
}

function MasterDataForm({
  title,
  initial,
  districtOptions,
  showState = false,
  onClose,
  onSubmit,
}: {
  title: string;
  initial?: MasterDataRecord;
  districtOptions?: readonly MasterDataRecord[] | undefined;
  showState?: boolean;
  onClose: () => void;
  onSubmit: (input: MasterDataInput) => void;
}): ReactNode {
  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [effectiveFrom, setEffectiveFrom] = useState(initial?.effectiveFrom ?? "");
  const [displayOrder, setDisplayOrder] = useState(String(initial?.displayOrder ?? ""));
  const [districtId, setDistrictId] = useState(initial?.districtId ?? "");
  const [state, setState] = useState(initial?.state ?? "");

  const ready = code.trim().length > 0 && name.trim().length > 0;

  return (
    <Modal open title={title} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code" hint="Internal, stable, lowercase_with_underscores.">
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={initial !== undefined}
              placeholder="e.g. leasehold"
            />
          </Field>
          <Field label="Display name">
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Leasehold" />
          </Field>
        </div>

        {districtOptions && (
          <Field label="District">
            <Select value={districtId} onChange={(event) => setDistrictId(event.target.value)}>
              <option value="">— None —</option>
              {districtOptions
                .filter((d) => d.isActive)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </Select>
          </Field>
        )}

        {showState && (
          <Field label="State" hint="Optional. Lets AOS group districts by state as coverage expands.">
            <Input value={state} onChange={(event) => setState(event.target.value)} placeholder="e.g. Tamil Nadu" />
          </Field>
        )}

        <Field label="Description" hint="Explains the value to office staff. Optional.">
          <Textarea value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Display order" hint="Lower numbers appear first in lists and dropdowns.">
            <Input
              type="number"
              value={displayOrder}
              onChange={(event) => setDisplayOrder(event.target.value)}
            />
          </Field>
          <Field label="Effective from" hint="Optional.">
            <Input
              type="date"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
            />
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
                ...(description ? { description } : {}),
                ...(notes ? { notes } : {}),
                ...(effectiveFrom ? { effectiveFrom } : {}),
                ...(displayOrder ? { displayOrder: Number(displayOrder) } : {}),
                ...(districtId ? { districtId: districtId as Id } : {}),
                ...(state ? { state } : {}),
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

// ---------------------------------------------------------------------------
// Document types — extra fields (ownerKind, requiresPeriod, requiresExpiry)
// are shown read-only. Milestone 5 gives them name/description/active
// management; changing what kind of thing a document type belongs to is a
// structural decision the requirement engine depends on, not a data edit.
// ---------------------------------------------------------------------------

function DocumentTypeSectionView({
  section,
  db,
  canManage,
}: {
  section: DocumentTypeSection;
  db: ReturnType<typeof useDatabase>;
  canManage: boolean;
}): ReactNode {
  const session = useSession();
  const toast = useToast();
  const [editing, setEditing] = useState<DocumentType | null>(null);

  const records = db.documentTypes.slice().sort((a, b) => a.displayOrder - b.displayOrder);
  const [query, setQuery, filtered] = useSearch(records);

  return (
    <Card title="Document Types" subtitle={section.hint}>
      <div className="space-y-3">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search document types…" />

        {filtered.length === 0 ? (
          <Empty>Nothing matches.</Empty>
        ) : (
          <ul className="divide-y divide-ink-100">
            {filtered.map((type) => (
              <li key={type.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {type.name}
                    {!type.isActive && <Badge tone="neutral">Inactive</Badge>}
                    <Badge tone="info">{type.ownerKind}</Badge>
                    {type.requiresPeriod && <Badge tone="warn">Period</Badge>}
                    {type.requiresExpiry && <Badge tone="warn">Expiry</Badge>}
                  </p>
                  <p className="tnum text-xs text-ink-500">
                    {type.code}
                    {type.description && ` · ${type.description}`}
                  </p>
                </div>
                {canManage && (
                  <div className="flex shrink-0 items-center gap-2">
                    <Button onClick={() => setEditing(type)}>Edit</Button>
                    <Button
                      variant={type.isActive ? "secondary" : "primary"}
                      onClick={() => {
                        const result = setDocumentTypeActive(type.id, !type.isActive, session.user.id);
                        toast.show(
                          result.ok
                            ? `${type.name} ${type.isActive ? "deactivated" : "reactivated"}.`
                            : (result.message ?? "Could not update."),
                          result.ok ? "good" : "bad",
                        );
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
        <NameDescriptionModal
          title="Edit Document Type"
          name={editing.name}
          description={editing.description ?? ""}
          onClose={() => setEditing(null)}
          onSubmit={(patch) => {
            const result = updateDocumentTypeDetails(editing.id, patch, session.user.id);
            if (result.ok) setEditing(null);
            toast.show(
              result.ok ? "Document type updated." : (result.message ?? "Could not update."),
              result.ok ? "good" : "bad",
            );
          }}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Rejection reasons — ADR-028. Same treatment as document types.
// ---------------------------------------------------------------------------

function RejectionReasonSectionView({
  section,
  db,
  canManage,
}: {
  section: RejectionReasonSection;
  db: ReturnType<typeof useDatabase>;
  canManage: boolean;
}): ReactNode {
  const session = useSession();
  const toast = useToast();
  const [editing, setEditing] = useState<RejectionReason | null>(null);

  const records = db.rejectionReasons.slice().sort((a, b) => a.displayOrder - b.displayOrder);
  const [query, setQuery, filtered] = useSearch(records);

  return (
    <Card title="Rejection Reasons" subtitle={section.hint}>
      <div className="space-y-3">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search rejection reasons…" />

        {filtered.length === 0 ? (
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
                      onClick={() => {
                        const result = setRejectionReasonActive(
                          reason.id,
                          !reason.isActive,
                          session.user.id,
                        );
                        toast.show(
                          result.ok
                            ? `${reason.name} ${reason.isActive ? "deactivated" : "reactivated"}.`
                            : (result.message ?? "Could not update."),
                          result.ok ? "good" : "bad",
                        );
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
          onSubmit={(patch) => {
            const result = updateRejectionReasonDetails(editing.id, patch, session.user.id);
            if (result.ok) setEditing(null);
            toast.show(
              result.ok ? "Rejection reason updated." : (result.message ?? "Could not update."),
              result.ok ? "good" : "bad",
            );
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
