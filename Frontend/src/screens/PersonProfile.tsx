/**
 * A person, across every case.
 *
 * This screen is where "information is entered once" becomes visible: one
 * person, every case they have ever been on in any role, and their documents on
 * file — because a document belongs to the person, not to the loan application
 * that referenced it (ADR-007).
 */

import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";

import { CASE_STAGE_LABELS } from "@domain/case/stages.js";

import { updatePerson, updatePersonIdentifiers } from "../fake/store.js";
import { useDatabase } from "../fake/useDatabase.js";
import type { CaseParty, PersonIdentifier } from "../fake/types.js";
import {
  bytes,
  casesForPerson,
  lakhs,
  maskedPan,
  money,
  panOf,
  primaryPhone,
  productLabel,
  titleCase,
  when,
} from "../lib.js";
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
import { StorageLocation } from "../ui/storage-location.js";

export function PersonProfile(): ReactNode {
  const { personId = "" } = useParams();
  const db = useDatabase();
  const session = useSession();
  const [expandedDocumentId, setExpandedDocumentId] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [addPhoneOpen, setAddPhoneOpen] = useState(false);

  const person = db.people.find((p) => p.id === personId);
  if (!person) return <Empty>Person not found.</Empty>;

  const canEdit = session.can("person.update", "all");

  const cases = casesForPerson(db, person.id);
  const documents = db.documents.filter((d) => d.personId === person.id);
  const employment = db.employments.find((e) => e.personId === person.id && e.isCurrent);
  const employer = db.organisations.find((o) => o.id === employment?.organisationId);
  const communications = db.communications
    .filter((c) => c.personId === person.id)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  const roleOn = (caseId: string): CaseParty | undefined =>
    db.caseParties.find((p) => p.caseId === caseId && p.personId === person.id && !p.removedAt);

  // People who share a phone number. Usually a family phone; occasionally a
  // recycled one. Either way it is worth showing rather than silently fusing.
  const sharedPhone = db.people.filter(
    (other) =>
      other.id !== person.id &&
      other.identifiers.some((a) =>
        person.identifiers.some(
          (b) => b.type === "phone" && a.type === "phone" && a.value === b.value,
        ),
      ),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{person.fullName}</h1>
          <p className="tnum mt-1 text-sm text-ink-500">
            {primaryPhone(person) ?? "No number"}
            {" · "}
            {session.can("identifier.view_full", "all")
              ? (panOf(person) ?? "No PAN")
              : (maskedPan(person) ?? "No PAN")}
            {person.locality && ` · ${person.locality}, ${person.city}`}
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
          {!session.can("identifier.view_full", "all") && (
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
            title={`${cases.length} case${cases.length === 1 ? "" : "s"}`}
            subtitle="Every role, every year. This is the question AOS exists to answer."
          >
            {cases.length === 0 ? (
              <Empty>No cases yet.</Empty>
            ) : (
              <ul className="divide-y divide-ink-100">
                {cases
                  .slice()
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .map((loanCase) => (
                    <li key={loanCase.id} className="py-2.5 first:pt-0 last:pb-0">
                      <Link
                        to={`/cases/${loanCase.id}`}
                        className="flex flex-wrap items-center gap-2 hover:underline"
                      >
                        <span className="tnum text-sm font-medium">{loanCase.caseNumber}</span>
                        <Badge>{titleCase(roleOn(loanCase.id)?.role ?? "party")}</Badge>
                        <span className="text-sm text-ink-700">{productLabel(db, loanCase)}</span>
                        <span className="tnum text-sm text-ink-500">
                          {lakhs(loanCase.requestedAmount)}
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

          {session.can("communication.read", "own") && (
            <Card
              title="Every conversation"
              subtitle="Across all their cases — a person's history is theirs, not a case's"
            >
              {communications.length === 0 ? (
                <Empty>Nothing logged.</Empty>
              ) : (
                <ul className="divide-y divide-ink-100">
                  {communications.map((communication) => (
                    <li key={communication.id} className="py-2.5 first:pt-0 last:pb-0">
                      <div className="flex items-center gap-2">
                        <Badge tone={communication.direction === "inbound" ? "good" : "neutral"}>
                          {communication.channel}
                        </Badge>
                        <span className="text-sm font-medium">{communication.subject}</span>
                        <span className="ml-auto text-xs text-ink-500">
                          {when(communication.occurredAt)}
                        </span>
                      </div>
                      {communication.body && (
                        <p className="mt-1 text-sm text-ink-700">{communication.body}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card
            title="Contact details"
            subtitle="A person can have more than one phone or email — an alternate number is a second entry, not a second person."
            actions={
              canEdit && <Button onClick={() => setAddPhoneOpen(true)}>Add phone or email</Button>
            }
          >
            {person.identifiers.length === 0 ? (
              <Empty>Nothing on file.</Empty>
            ) : (
              <ul className="space-y-1.5">
                {person.identifiers.map((identifier) => (
                  <li key={identifier.id} className="flex items-center gap-2 text-sm">
                    <span className="tnum flex-1">
                      {identifier.type === "pan" && !session.can("identifier.view_full", "all")
                        ? maskedPan(person)
                        : identifier.value}
                    </span>
                    <Badge>{titleCase(identifier.type)}</Badge>
                    {identifier.isPrimary && <Badge tone="info">Primary</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {employment && employer && (
            <Card title="Employment">
              <p className="text-sm font-medium">{employer.canonicalName}</p>
              <p className="text-xs text-ink-500">
                {employment.designation} · {titleCase(employment.employmentType)}
              </p>
              {employment.monthlyIncome && (
                <p className="tnum mt-1 text-sm">{money(employment.monthlyIncome)} / month</p>
              )}
              <p className="mt-2 border-t border-ink-100 pt-2 text-xs text-ink-500">
                Employment type drives which income documents this person's cases ask for.
              </p>
            </Card>
          )}

          {session.can("document.read", "own") && (
            <Card
              title="Documents on file"
              subtitle="Owned by the person, reused by every case"
            >
              {documents.length === 0 ? (
                <Empty>Nothing on file.</Empty>
              ) : (
                <ul className="space-y-2">
                  {documents.map((document) => {
                    const type = db.documentTypes.find((t) => t.id === document.documentTypeId);
                    const expanded = expandedDocumentId === document.id;
                    return (
                      <li key={document.id} className="space-y-1.5">
                        <div className="flex items-start gap-2">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">{type?.name}</span>
                            <span className="block truncate text-xs text-ink-500">
                              {document.fileName} · {bytes(document.fileSizeBytes)}
                            </span>
                          </span>
                          <Badge tone={document.verifiedAt ? "good" : "info"}>
                            {document.verifiedAt ? "Verified" : "Unverified"}
                          </Badge>
                          <Button
                            variant="ghost"
                            onClick={() => setExpandedDocumentId(expanded ? null : document.id)}
                          >
                            {expanded ? "Hide storage" : "Storage"}
                          </Button>
                        </div>
                        {expanded && <StorageLocation filePath={document.filePath} />}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          )}

          {sharedPhone.length > 0 && (
            <Card title="Shares a phone number">
              <ul className="space-y-1.5">
                {sharedPhone.map((other) => (
                  <li key={other.id}>
                    <Link to={`/people/${other.id}`} className="text-sm hover:underline">
                      {other.fullName}
                    </Link>
                  </li>
                ))}
              </ul>
              <p className="mt-2 border-t border-ink-100 pt-2 text-xs text-ink-500">
                Deliberately two records. A number is evidence, not identity: numbers are shared and
                recycled, and fusing these two would attach one person's history to another's.
              </p>
            </Card>
          )}
        </div>
      </div>

      <EditPersonDialog personId={person.id} open={editOpen} onClose={() => setEditOpen(false)} />
      <AddIdentifierDialog
        personId={person.id}
        open={addPhoneOpen}
        onClose={() => setAddPhoneOpen(false)}
      />
    </div>
  );
}

/**
 * Correct a person's own record — name, date of birth, residential address.
 *
 * NOT case-specific (Telecaller Real-World Issues milestone, Part 3). This
 * writes through `updatePerson`, which changes what every case involving
 * this person shows — a date of birth is a fact about the person, not about
 * whichever loan happened to be open when someone learned it.
 */
function EditPersonDialog({
  personId,
  open,
  onClose,
}: {
  personId: string;
  open: boolean;
  onClose: () => void;
}): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const toast = useToast();
  const person = db.people.find((p) => p.id === personId);

  const [fullName, setFullName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [addressLine, setAddressLine] = useState("");
  const [locality, setLocality] = useState("");
  const [city, setCity] = useState("");
  const [pincode, setPincode] = useState("");
  const [district, setDistrict] = useState("");
  const [state, setState] = useState("");

  useEffect(() => {
    if (!open || !person) return;
    setFullName(person.fullName);
    setDateOfBirth(person.dateOfBirth ?? "");
    setAddressLine(person.addressLine ?? "");
    setLocality(person.locality ?? "");
    setCity(person.city ?? "");
    setPincode(person.pincode ?? "");
    setDistrict(person.district ?? "");
    setState(person.state ?? "");
  }, [open, person]);

  if (!person) return null;

  const save = (): void => {
    const result = updatePerson(
      personId,
      { fullName, dateOfBirth, addressLine, locality, city, pincode, district, state },
      session.user.id,
    );
    if (!result.ok) {
      toast.show(result.message ?? "", "bad");
      return;
    }
    toast.show("Saved.");
    onClose();
  };

  return (
    <Modal open={open} title={`Edit ${person.fullName}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Full name">
          <Input value={fullName} onChange={(event) => setFullName(event.target.value)} />
        </Field>
        <Field label="Date of birth">
          <Input
            type="date"
            value={dateOfBirth}
            onChange={(event) => setDateOfBirth(event.target.value)}
          />
        </Field>
        <Field label="Address">
          <Input
            value={addressLine}
            onChange={(event) => setAddressLine(event.target.value)}
            placeholder="12 Mill Road"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Locality">
            <Input value={locality} onChange={(event) => setLocality(event.target.value)} />
          </Field>
          <Field label="City">
            <Input value={city} onChange={(event) => setCity(event.target.value)} />
          </Field>
          <Field label="District">
            <Input value={district} onChange={(event) => setDistrict(event.target.value)} />
          </Field>
          <Field label="State">
            <Input value={state} onChange={(event) => setState(event.target.value)} />
          </Field>
          <Field label="PIN code">
            <Input value={pincode} onChange={(event) => setPincode(event.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Back
          </Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Add another phone number or email — an "alternate mobile" is a second
 * identifier, not a field this schema has a dedicated place for (Part 3).
 * Editing an existing one is not offered here; the value shown on the
 * profile is corrected by adding a fresh one and leaving the old one on
 * file, exactly like every other identifier already on the person.
 */
function AddIdentifierDialog({
  personId,
  open,
  onClose,
}: {
  personId: string;
  open: boolean;
  onClose: () => void;
}): ReactNode {
  const session = useSession();
  const toast = useToast();
  const [type, setType] = useState<PersonIdentifier["type"]>("phone");
  const [value, setValue] = useState("");
  const [makePrimary, setMakePrimary] = useState(false);

  const close = (): void => {
    setValue("");
    setMakePrimary(false);
    onClose();
  };

  return (
    <Modal open={open} title="Add a phone number or email" onClose={close}>
      <div className="space-y-3">
        <Field label="Kind">
          <Select
            value={type}
            onChange={(event) => setType(event.target.value as PersonIdentifier["type"])}
          >
            <option value="phone">Phone</option>
            <option value="email">Email</option>
          </Select>
        </Field>
        <Field label="Value">
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={type === "phone" ? "+91 90000 00000" : "name@example.com"}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={makePrimary}
            onChange={(event) => setMakePrimary(event.target.checked)}
          />
          Make this the primary {type}
        </label>
        <p className="text-xs text-ink-500">
          {makePrimary
            ? `The current primary ${type}, if there is one, stops being primary — it stays on file.`
            : `Kept alongside the existing ${type} numbers, not instead of them.`}
        </p>
        <div className="flex flex-col items-end gap-1 pt-1">
          <div className="flex gap-2">
            <Button variant="ghost" onClick={close}>
              Back
            </Button>
            <Button
              variant="primary"
              disabled={value.trim().length < 3}
              onClick={() => {
                const result = updatePersonIdentifiers(
                  personId,
                  { type, value, isPrimary: makePrimary },
                  session.user.id,
                );
                if (!result.ok) {
                  toast.show(result.message ?? "", "bad");
                  return;
                }
                toast.show("Added.");
                close();
              }}
            >
              Add
            </Button>
          </div>
          {value.trim().length < 3 ? (
            <p className="text-xs text-amber-700" role="status">
              Enter at least 3 characters for the {type === "phone" ? "phone number" : "email address"}.
            </p>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
