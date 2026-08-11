/**
 * A person, across every case.
 *
 * This screen is where "information is entered once" becomes visible: one
 * person, every case they have ever been on in any role — because a customer
 * belongs to the company, not to the loan application that first referenced
 * them (ADR-007).
 *
 * Stage 3B: the person and their cases come from PostgreSQL. Two consequences
 * worth knowing.
 *
 * FIRST, the case list here is SCOPE-FILTERED by the server. A Telecaller
 * looking at a customer they share with a colleague sees their own cases on
 * that person and not the colleague's. That is not a new rule — `case.read` at
 * `own` always meant this — it is the first time the rule is actually applied
 * to this screen, which used to read every case in the store.
 *
 * SECOND, employment, documents and conversations are gone from this screen
 * for now. They were the prototype store's, they have not migrated, and
 * showing a person's document count from a store that no longer describes
 * these cases would be a confident lie. Each returns with its own slice.
 */

import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";

import { CASE_STAGE_LABELS } from "@domain/case/stages.js";

import { api } from "../api/client.js";
import { useReference } from "../api/catalogue.js";
import { useApiQuery, useMutation } from "../api/hooks.js";
import type { ApiCaseForPerson, ApiCustomer, ApiIdentifier, IdentifierType } from "../api/types.js";
import { lakhs, titleCase, when } from "../lib.js";
import { useSession } from "../session.js";
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Modal,
  PermissionCode,
  Select,
  StageBadge,
  useToast,
} from "../ui/index.js";

/** PAN, masked. Stands in for what ADR-026 does in the database: everyone sees
 * the shape, only `identifier.view_full` sees the value. */
function maskPan(value: string): string {
  return `${value.slice(0, 3)}xxxxx${value.slice(-1)}`;
}

export function PersonProfile(): ReactNode {
  const { personId = "" } = useParams();
  const session = useSession();
  const reference = useReference();

  const customer = useApiQuery<ApiCustomer>(personId ? `/customers/${personId}` : null);
  const cases = useApiQuery<readonly ApiCaseForPerson[]>(
    personId ? `/customers/${personId}/cases` : null,
  );

  const [editOpen, setEditOpen] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(false);

  if (customer.loading) return <Empty>Loading…</Empty>;
  if (customer.error || !customer.data) {
    return <Empty>{customer.error?.message ?? "Person not found."}</Empty>;
  }

  const person = customer.data;
  const canEdit = session.can("person.update", "all");
  const seesFullIdentifiers = session.can("identifier.view_full", "all");

  const primaryPhone = person.identifiers.find((i) => i.type === "phone" && i.isPrimary)?.value;
  const pan = person.identifiers.find((i) => i.type === "pan")?.value;
  const theirCases = cases.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{person.fullName}</h1>
          <p className="tnum mt-1 text-sm text-ink-500">
            {primaryPhone ?? "No number"}
            {" · "}
            {pan ? (seesFullIdentifiers ? pan : maskPan(pan)) : "No PAN"}
            {person.locality && ` · ${person.locality}, ${person.city ?? ""}`}
          </p>
          {(person.addressLine || person.pincode || person.district || person.state) && (
            <p className="mt-0.5 text-xs text-ink-500">
              {[person.addressLine, person.district, person.state, person.pincode]
                .filter(Boolean)
                .join(", ")}
            </p>
          )}
          {person.dateOfBirth && (
            <p className="mt-0.5 text-xs text-ink-500">Born {person.dateOfBirth}</p>
          )}
          {person.aliases.length > 0 && (
            <p className="mt-1 text-xs text-ink-500">
              Also known as {person.aliases.map((alias) => `"${alias}"`).join(", ")} — every
              spelling stays searchable, because that is what somebody will type next time.
            </p>
          )}
          {!seesFullIdentifiers && pan && (
            <div className="mt-1">
              <p className="text-xs text-ink-400">
                PAN is masked. Full PAN is only visible to Login Desk and above.
              </p>
              <PermissionCode code="identifier.view_full" />
            </div>
          )}
        </div>
        {canEdit && (
          <div className="flex shrink-0 gap-1.5">
            <Button onClick={() => setEditOpen(true)}>Edit</Button>
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card
            title={`${theirCases.length} case${theirCases.length === 1 ? "" : "s"}`}
            subtitle={
              session.can("case.read", "all")
                ? "Every role, every year. This is the question AOS exists to answer."
                : "Cases you own. A colleague's case on this customer is not yours to browse."
            }
          >
            {cases.loading ? (
              <Empty>Loading cases…</Empty>
            ) : theirCases.length === 0 ? (
              <Empty>No cases yet.</Empty>
            ) : (
              <ul className="divide-y divide-ink-100">
                {theirCases.map((loanCase) => (
                  <li key={loanCase.id} className="py-2.5 first:pt-0 last:pb-0">
                    <Link
                      to={`/cases/${loanCase.id}`}
                      className="flex flex-wrap items-center gap-2 hover:underline"
                    >
                      <span className="tnum text-sm font-medium">{loanCase.caseNumber}</span>
                      <Badge>{titleCase(loanCase.partyRole)}</Badge>
                      <span className="text-sm text-ink-700">
                        {reference.productLabel(loanCase.loanProductId)}
                      </span>
                      <span className="tnum text-sm text-ink-500">
                        {lakhs(loanCase.requestedAmount ?? undefined)}
                      </span>
                      <span className="ml-auto">
                        <StageBadge
                          stage={loanCase.stage}
                          label={CASE_STAGE_LABELS[loanCase.stage]}
                        />
                      </span>
                    </Link>
                    <p className="mt-0.5 text-xs text-ink-500">
                      Opened {when(loanCase.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Documents, employment and conversations">
            <div className="max-w-prose space-y-3">
              <p className="text-sm font-medium text-ink-900">Not yet migrated.</p>
              <p className="text-sm text-ink-700">
                This customer lives in PostgreSQL. Their documents, employment record and logged
                conversations have not moved to the server yet, so they are not shown here rather
                than shown from a store that no longer describes these cases.
              </p>
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card
            title="Contact details"
            subtitle="A person can have more than one phone or email — an alternate number is a second entry, not a second person."
            actions={canEdit && <Button onClick={() => setContactsOpen(true)}>Edit contacts</Button>}
          >
            {person.identifiers.length === 0 ? (
              <Empty>Nothing on file.</Empty>
            ) : (
              <ul className="space-y-1.5">
                {person.identifiers.map((identifier) => (
                  <li key={identifier.id} className="flex items-center gap-2 text-sm">
                    <span className="tnum flex-1">
                      {identifier.type === "pan" && !seesFullIdentifiers
                        ? maskPan(identifier.value)
                        : identifier.value}
                    </span>
                    <Badge>{titleCase(identifier.type)}</Badge>
                    {identifier.isPrimary && <Badge tone="info">Primary</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Where this data lives">
            <p className="text-xs text-ink-600">
              This customer is a row in PostgreSQL. Anyone in the office searching their name or
              number finds this same record — which is what stops the same person being created
              twice on two PCs.
            </p>
          </Card>
        </div>
      </div>

      {editOpen && (
        <EditPersonModal
          person={person}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            customer.refetch();
            setEditOpen(false);
          }}
        />
      )}
      {contactsOpen && (
        <EditContactsModal
          person={person}
          onClose={() => setContactsOpen(false)}
          onSaved={() => {
            customer.refetch();
            setContactsOpen(false);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function EditPersonModal({
  person,
  onClose,
  onSaved,
}: {
  person: ApiCustomer;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const mutation = useMutation();
  const toast = useToast();
  const [form, setForm] = useState({
    fullName: person.fullName,
    dateOfBirth: person.dateOfBirth ?? "",
    addressLine: person.addressLine ?? "",
    locality: person.locality ?? "",
    city: person.city ?? "",
    district: person.district ?? "",
    state: person.state ?? "",
    pincode: person.pincode ?? "",
  });

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  return (
    <Modal open title="Edit customer" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name">
          <Input
            name="fullName"
            value={form.fullName}
            onChange={(e) => set("fullName")(e.target.value)}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Date of birth">
            <Input
              type="date"
              value={form.dateOfBirth}
              onChange={(e) => set("dateOfBirth")(e.target.value)}
            />
          </Field>
          <Field label="Pincode">
            <Input value={form.pincode} onChange={(e) => set("pincode")(e.target.value)} />
          </Field>
        </div>
        <Field label="Address">
          <Input value={form.addressLine} onChange={(e) => set("addressLine")(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Locality">
            <Input
              name="locality"
              value={form.locality}
              onChange={(e) => set("locality")(e.target.value)}
            />
          </Field>
          <Field label="City">
            <Input value={form.city} onChange={(e) => set("city")(e.target.value)} />
          </Field>
          <Field label="District">
            <Input value={form.district} onChange={(e) => set("district")(e.target.value)} />
          </Field>
          <Field label="State">
            <Input value={form.state} onChange={(e) => set("state")(e.target.value)} />
          </Field>
        </div>

        {mutation.error && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
            {mutation.error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={mutation.pending || form.fullName.trim().length === 0}
            onClick={async () => {
              const saved = await mutation.run(() =>
                api<ApiCustomer>(`/customers/${person.id}`, { method: "PATCH", body: form }),
              );
              if (saved) {
                toast.show("Saved.");
                onSaved();
              }
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

const IDENTIFIER_TYPES: readonly IdentifierType[] = ["phone", "pan", "email", "bank_account"];

/**
 * Editing contact details as one list rather than one "add" dialog per kind.
 *
 * The server replaces the set: anything dropped here is EXPIRED rather than
 * deleted, so a call logged against an old number stays attributable to the
 * person who held it at the time. That is why removing a number is safe enough
 * to offer inline.
 */
/**
 * `value` on each row is a DISPLAY string — `person.identifiers[].value` is
 * masked (ADR-026), so an untouched row's `value` is never the real number.
 * `id` + `edited: false` means "leave this identifier exactly as it is"; the
 * server resolves it without ever needing the raw value. Typing into a row
 * flips `edited`, and only then is `value` treated as a real number to save —
 * see the submit handler below for why an unedited row must never be sent as
 * a value.
 */
interface ContactRow {
  readonly id?: string;
  readonly type: IdentifierType;
  readonly value: string;
  readonly isPrimary: boolean;
  readonly edited: boolean;
}

function EditContactsModal({
  person,
  onClose,
  onSaved,
}: {
  person: ApiCustomer;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const mutation = useMutation();
  const toast = useToast();
  const [rows, setRows] = useState<ContactRow[]>(() =>
    person.identifiers.map((i: ApiIdentifier) => ({
      id: i.id,
      type: i.type,
      value: i.value,
      isPrimary: i.isPrimary,
      edited: false,
    })),
  );

  const update = (index: number, patch: Partial<ContactRow>): void =>
    setRows((current) =>
      current.map((row, i) => {
        if (i !== index) {
          // At most one primary per kind, so selecting one clears the others.
          return patch.isPrimary && row.type === (patch.type ?? current[index]!.type)
            ? { ...row, isPrimary: false }
            : row;
        }
        // Typing a new value replaces this row's identifier outright — the
        // masked display it started from is never what gets saved.
        const edited = row.edited || patch.value !== undefined;
        return { ...row, ...patch, edited };
      }),
    );

  return (
    <Modal open title="Contact details" onClose={onClose}>
      <div className="space-y-3">
        {rows.length === 0 && <Empty>Nothing on file. Add a number below.</Empty>}

        <ul className="space-y-2">
          {rows.map((row, index) => (
            <li key={index} className="flex items-end gap-2">
              <Field label="Type">
                <Select
                  value={row.type}
                  onChange={(e) => update(index, { type: e.target.value as IdentifierType })}
                >
                  {IDENTIFIER_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {titleCase(type)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Value">
                <Input
                  value={row.value}
                  onChange={(e) => update(index, { value: e.target.value })}
                />
              </Field>
              <label className="flex items-center gap-1 pb-2 text-xs text-ink-600">
                <input
                  type="checkbox"
                  checked={row.isPrimary}
                  onChange={(e) => update(index, { isPrimary: e.target.checked })}
                />
                Primary
              </label>
              <Button
                className="mb-1"
                onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>

        <Button
          onClick={() =>
            setRows((current) => [
              ...current,
              { type: "phone", value: "", isPrimary: false, edited: true },
            ])
          }
        >
          Add another
        </Button>

        <p className="text-xs text-ink-500">
          A number you remove is kept as expired, never deleted — a call logged in 2024 stays
          attributed to whoever held that number in 2024.
        </p>

        {mutation.error && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
            {mutation.error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={mutation.pending}
            onClick={async () => {
              // Unedited rows go by `id` alone (ADR-026): `row.value` on those
              // is the masked display, never the real number, and sending it
              // back as if it were a fresh value would overwrite the real one
              // with literal x's. Edited and newly-added rows send a real
              // value, exactly as before.
              const saved = await mutation.run(() =>
                api<ApiCustomer>(`/customers/${person.id}/identifiers`, {
                  method: "PUT",
                  body: {
                    identifiers: rows
                      .filter((row) => row.edited || row.id)
                      .map((row) =>
                        row.edited
                          ? { type: row.type, value: row.value.trim(), isPrimary: row.isPrimary }
                          : { id: row.id, isPrimary: row.isPrimary },
                      )
                      .filter((entry) => "id" in entry || entry.value.length > 0),
                  },
                }),
              );
              if (saved) {
                toast.show("Contact details saved.");
                onSaved();
              }
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
