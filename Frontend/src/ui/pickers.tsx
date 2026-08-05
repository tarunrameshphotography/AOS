/**
 * Search-first person and organisation pickers.
 *
 * The workflow the whole system depends on (Product Principle #3, Identity
 * Resolution Parts 2 and 4): type, search existing records, rank likely
 * matches, and create immediately if nothing matches. Once created, that
 * record becomes globally reusable — the same picker is used whether the
 * person is a case's applicant or a co-applicant added in week three.
 *
 * No screen that attaches a customer or a firm to a case may fall back to a
 * plain dropdown of every person or every organisation on file — that is
 * exactly the abstraction leak Product Principle #3 forbids, and the failure
 * this component exists to remove.
 */

import { useMemo, type ReactNode } from "react";

import type { Database, Id, Organisation } from "../fake/types.js";
import {
  casesForPerson,
  organisationCandidates,
  personCandidates,
  primaryPhone,
  titleCase,
  verifiedDocumentsFor,
} from "../lib.js";
import { Badge, Button, Field, Input } from "./index.js";

// ---------------------------------------------------------------------------
// Person
// ---------------------------------------------------------------------------

export interface PersonSearchFieldProps {
  db: Database;
  name: string;
  phone: string;
  chosenPersonId: Id | null;
  onNameChange: (value: string) => void;
  onPhoneChange: (value: string) => void;
  onChoose: (personId: Id | null) => void;
  /** Extra context shown once a candidate is chosen — e.g. what carries over. */
  chosenHint?: ReactNode;
}

export function PersonSearchField({
  db,
  name,
  phone,
  chosenPersonId,
  onNameChange,
  onPhoneChange,
  onChoose,
  chosenHint,
}: PersonSearchFieldProps): ReactNode {
  const chosen = db.people.find((p) => p.id === chosenPersonId);
  const candidates = useMemo(() => personCandidates(db, name, phone), [db, name, phone]);

  if (chosen) {
    return (
      <div className="flex items-start gap-3 rounded-md bg-brand-100 p-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{chosen.fullName}</p>
          <p className="text-xs text-ink-700">
            {casesForPerson(db, chosen.id).length} previous case
            {casesForPerson(db, chosen.id).length === 1 ? "" : "s"} ·{" "}
            {verifiedDocumentsFor(db, chosen.id)} verified documents on file
          </p>
          {chosenHint && <p className="mt-1 text-xs text-ink-500">{chosenHint}</p>}
        </div>
        <Button onClick={() => onChoose(null)}>Change</Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder="However they said it"
          />
        </Field>
        <Field label="Phone">
          <Input
            value={phone}
            onChange={(event) => onPhoneChange(event.target.value)}
            placeholder="98431 20045"
          />
        </Field>
      </div>

      {candidates.length > 0 && (
        <div className="rounded-md ring-1 ring-amber-200">
          <p className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            AOS may already know them. A missed duplicate is a permanent data wound; a false
            warning costs two seconds.
          </p>
          <ul className="divide-y divide-ink-100">
            {candidates.map(({ person, tier }) => (
              <li key={person.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{person.fullName}</p>
                  <p className="text-xs text-ink-500">
                    {primaryPhone(person)} · {casesForPerson(db, person.id).length} cases
                    {person.aliases.length > 0 && ` · also "${person.aliases[0]}"`}
                  </p>
                </div>
                <Badge tone={tier === "definite" ? "good" : tier === "probable" ? "warn" : "neutral"}>
                  {tier}
                </Badge>
                <Button onClick={() => onChoose(person.id)}>This one</Button>
              </li>
            ))}
          </ul>
          <p className="border-t border-ink-100 px-3 py-2 text-xs text-ink-500">
            None of these? Carry on typing — creating a different person is always available, and
            the assertion is recorded.
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Organisation
// ---------------------------------------------------------------------------

export interface OrganisationSearchFieldProps {
  db: Database;
  name: string;
  chosenOrganisationId: Id | null;
  onNameChange: (value: string) => void;
  onChoose: (organisationId: Id | null) => void;
}

export function OrganisationSearchField({
  db,
  name,
  chosenOrganisationId,
  onNameChange,
  onChoose,
}: OrganisationSearchFieldProps): ReactNode {
  const chosen: Organisation | undefined = db.organisations.find(
    (o) => o.id === chosenOrganisationId,
  );
  const candidates = useMemo(() => organisationCandidates(db, name), [db, name]);

  if (chosen) {
    return (
      <div className="flex items-start gap-3 rounded-md bg-brand-100 p-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{chosen.canonicalName}</p>
          <p className="text-xs text-ink-700">
            {chosen.roles.map(titleCase).join(", ")}
            {chosen.city && ` · ${chosen.city}`}
          </p>
        </div>
        <Button onClick={() => onChoose(null)}>Change</Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Field
        label="Firm name"
        hint="Type it however it's known. AOS resolves it in the background — this is never a list of every organisation on file."
      >
        <Input
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="However it's known"
        />
      </Field>

      {candidates.length > 0 && (
        <div className="rounded-md ring-1 ring-amber-200">
          <p className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            AOS may already know this firm.
          </p>
          <ul className="divide-y divide-ink-100">
            {candidates.map(({ organisation, tier }) => (
              <li key={organisation.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{organisation.canonicalName}</p>
                  <p className="text-xs text-ink-500">{organisation.roles.map(titleCase).join(", ")}</p>
                </div>
                <Badge tone={tier === "definite" ? "good" : "neutral"}>{tier}</Badge>
                <Button onClick={() => onChoose(organisation.id)}>This one</Button>
              </li>
            ))}
          </ul>
          <p className="border-t border-ink-100 px-3 py-2 text-xs text-ink-500">
            Not this one? Two genuinely different firms can share a name — carry on typing to
            create a distinct organisation.
          </p>
        </div>
      )}
    </div>
  );
}
