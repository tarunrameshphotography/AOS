/**
 * Search-first customer picker, over the API.
 *
 * The workflow the whole system depends on (Product Principle #3): type,
 * search existing records, rank likely matches, create immediately if nothing
 * matches. A dropdown of every customer on file is the exact abstraction leak
 * that principle forbids — and is now impossible anyway, since "every customer
 * on file" is a table in PostgreSQL rather than an array in the tab.
 *
 * THE SEARCH IS SERVER-SIDE, which is the substantive change from
 * `ui/pickers.tsx`. That version ranked candidates over the people the browser
 * happened to be holding. This asks the database, so the duplicate warning
 * works against every customer the company has ever recorded rather than the
 * ones this session had loaded — which is the difference between the
 * duplicate check being a feature and being a coincidence.
 *
 * The ranking rule is shared with the prototype picker (`identity-match.ts`):
 * a phone match alone is never Definite.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { api } from "../api/client.js";
import type { ApiCustomer } from "../api/types.js";
import { matchTier, worthSearching, type MatchTier } from "../identity-match.js";
import { Badge, Button, Field, Input } from "./index.js";

interface Candidate {
  readonly customer: ApiCustomer;
  readonly tier: MatchTier;
}

function phonesOf(customer: ApiCustomer): string[] {
  return customer.identifiers.filter((i) => i.type === "phone").map((i) => i.value);
}

function primaryPhoneOf(customer: ApiCustomer): string | undefined {
  return customer.identifiers.find((i) => i.type === "phone" && i.isPrimary)?.value;
}

export interface CustomerSearchFieldProps {
  readonly name: string;
  readonly phone: string;
  readonly chosen: ApiCustomer | null;
  readonly onNameChange: (value: string) => void;
  readonly onPhoneChange: (value: string) => void;
  readonly onChoose: (customer: ApiCustomer | null) => void;
  /** Extra context shown once a candidate is chosen — e.g. what carries over. */
  readonly chosenHint?: ReactNode;
}

export function CustomerSearchField({
  name,
  phone,
  chosen,
  onNameChange,
  onPhoneChange,
  onChoose,
  chosenHint,
}: CustomerSearchFieldProps): ReactNode {
  const [results, setResults] = useState<readonly ApiCustomer[]>([]);
  const [searching, setSearching] = useState(false);

  // Debounced, because this fires on every keystroke during a phone call and
  // the office runs on one small server. 250ms is under the threshold where
  // the suggestions feel like they are lagging behind the typing.
  const query = phone.replace(/\D/g, "").length >= 4 ? phone : name;
  const shouldSearch = chosen === null && worthSearching(name, phone);

  useEffect(() => {
    if (!shouldSearch) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      api<readonly ApiCustomer[]>(`/customers?q=${encodeURIComponent(query.trim())}`)
        .then((found) => {
          if (!cancelled) setResults(found);
        })
        .catch(() => {
          // A failed duplicate check must never block opening a case. The
          // worst outcome is a duplicate, which is recoverable; a telecaller
          // unable to record a live call is not.
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, shouldSearch]);

  const candidates = useMemo<Candidate[]>(() => {
    if (!shouldSearch) return [];
    return results
      .map((customer) => {
        const tier = matchTier(
          { fullName: customer.fullName, aliases: customer.aliases, phones: phonesOf(customer) },
          name,
          phone,
        );
        return tier === null ? null : { customer, tier };
      })
      .filter((entry): entry is Candidate => entry !== null)
      .slice(0, 4);
  }, [results, name, phone, shouldSearch]);

  if (chosen) {
    return (
      <div className="flex items-start gap-3 rounded-md bg-brand-100 p-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{chosen.fullName}</p>
          <p className="text-xs text-ink-700">
            {primaryPhoneOf(chosen) ?? "No number on file"}
            {chosen.locality ? ` · ${chosen.locality}` : ""}
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
            name="applicantName"
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder="However they said it"
          />
        </Field>
        <Field label="Phone">
          <Input
            name="applicantPhone"
            value={phone}
            onChange={(event) => onPhoneChange(event.target.value)}
            placeholder="98431 20045"
          />
        </Field>
      </div>

      {candidates.length > 0 && (
        <div className="rounded-md ring-1 ring-amber-200" data-testid="duplicate-warning">
          <p className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            AOS may already know them. A missed duplicate is a permanent data wound; a false
            warning costs two seconds.
          </p>
          <ul className="divide-y divide-ink-100">
            {candidates.map(({ customer, tier }) => (
              <li key={customer.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{customer.fullName}</p>
                  <p className="text-xs text-ink-500">
                    {primaryPhoneOf(customer) ?? "No number"}
                    {customer.locality ? ` · ${customer.locality}` : ""}
                    {customer.aliases.length > 0 && ` · also "${customer.aliases[0]}"`}
                  </p>
                </div>
                <Badge
                  tone={tier === "definite" ? "good" : tier === "probable" ? "warn" : "neutral"}
                >
                  {tier}
                </Badge>
                <Button onClick={() => onChoose(customer)}>This one</Button>
              </li>
            ))}
          </ul>
          <p className="border-t border-ink-100 px-3 py-2 text-xs text-ink-500">
            None of these? Carry on typing — creating a different person is always available, and
            the assertion is recorded.
          </p>
        </div>
      )}

      {searching && candidates.length === 0 && (
        <p className="text-xs text-ink-400">Checking whether AOS already knows them…</p>
      )}
    </div>
  );
}
