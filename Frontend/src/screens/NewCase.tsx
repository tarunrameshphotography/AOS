/**
 * Creating a case.
 *
 * Asks for the applicant and the loan type. Nothing else — no co-applicant
 * field, no guarantor section, no property. Optional participants are added by
 * an explicit action later, never by a form field sitting empty waiting to be
 * filled (Principle #1).
 *
 * The interesting part is the duplicate check: typing a name or a number that
 * AOS already knows surfaces the match inline, because recognising a repeat
 * customer is the moment the system visibly beats memory.
 */

import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { createCase } from "../fake/store.js";
import { useDatabase } from "../fake/useDatabase.js";
import { casesForPerson, primaryPhone, verifiedDocumentsFor, when } from "../lib.js";
import { useSession } from "../session.js";
import { Badge, Button, Card, Field, Input, Select, cx, useToast } from "../ui/index.js";

export function NewCase(): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const navigate = useNavigate();
  const toast = useToast();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [productId, setProductId] = useState(db.loanProducts[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [source, setSource] = useState("Phone enquiry");
  const [chosenPersonId, setChosenPersonId] = useState<string | null>(null);

  if (!session.can("case.create", "all")) {
    return (
      <Card title="Not permitted">
        <p className="text-sm text-ink-700">
          This user does not hold <code>case.create</code>.
        </p>
      </Card>
    );
  }

  /**
   * Candidates, tiered by strength.
   *
   * A phone match on its own is Probable, never Definite — that is the family
   * phone and the recycled-number case, and assuming identity there is how one
   * person's history ends up attached to another's (ADR-013).
   */
  const candidates = useMemo(() => {
    const digits = phone.replace(/\D/g, "");
    const needle = name.trim().toLowerCase();
    if (digits.length < 4 && needle.length < 3) return [];

    return db.people
      .map((person) => {
        const phoneHit =
          digits.length >= 4 &&
          person.identifiers.some(
            (identifier) =>
              identifier.type === "phone" &&
              identifier.value.replace(/\D/g, "").includes(digits),
          );
        const nameHit =
          needle.length >= 3 &&
          [person.fullName, ...person.aliases].some((value) =>
            value.toLowerCase().includes(needle),
          );

        if (!phoneHit && !nameHit) return null;

        const tier: "definite" | "probable" | "possible" =
          phoneHit && nameHit ? "definite" : phoneHit ? "probable" : "possible";

        return { person, tier };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .slice(0, 4);
  }, [db.people, name, phone]);

  const chosen = db.people.find((p) => p.id === chosenPersonId);

  const submit = (): void => {
    const caseId = createCase(
      {
        ...(chosenPersonId ? { applicantPersonId: chosenPersonId } : {}),
        ...(chosenPersonId ? {} : { newApplicantName: name.trim(), newApplicantPhone: phone.trim() }),
        loanProductId: productId,
        ...(amount ? { requestedAmount: Number(amount) } : {}),
        source,
      },
      session.user.id,
    );
    toast.show("Case opened. Its number was allocated straight away — quotable on this call.");
    navigate(`/cases/${caseId}`);
  };

  const ready = productId !== "" && (chosenPersonId !== null || name.trim().length > 1);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">New case</h1>
        <p className="mt-1 text-sm text-ink-500">
          The applicant and the loan type. Everything else is added when reality supplies it.
        </p>
      </div>

      <Card title="Who is applying">
        <div className="space-y-3">
          {chosen ? (
            <div className="flex items-start gap-3 rounded-md bg-brand-100 p-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{chosen.fullName}</p>
                <p className="text-xs text-ink-700">
                  {casesForPerson(db, chosen.id).length} previous case
                  {casesForPerson(db, chosen.id).length === 1 ? "" : "s"} ·{" "}
                  {verifiedDocumentsFor(db, chosen.id)} verified documents on file
                </p>
                <p className="mt-1 text-xs text-ink-500">
                  Their KYC carries over. This case will open with those requirements already
                  satisfied.
                </p>
              </div>
              <Button onClick={() => setChosenPersonId(null)}>Change</Button>
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name">
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="However they said it"
                  />
                </Field>
                <Field label="Phone">
                  <Input
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
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
                        <Badge
                          tone={tier === "definite" ? "good" : tier === "probable" ? "warn" : "neutral"}
                        >
                          {tier}
                        </Badge>
                        <Button onClick={() => setChosenPersonId(person.id)}>This one</Button>
                      </li>
                    ))}
                  </ul>
                  <p className="border-t border-ink-100 px-3 py-2 text-xs text-ink-500">
                    None of these? Carry on typing — creating a different person is always
                    available, and the assertion is recorded.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </Card>

      <Card title="What they want">
        <div className="space-y-3">
          <Field
            label="Loan type"
            hint="Known at creation, before any bank is chosen — which is what makes the requirement list possible."
          >
            <Select value={productId} onChange={(event) => setProductId(event.target.value)}>
              {db.loanProducts.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.category} · {product.variant}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Amount" hint="Rough is fine.">
              <Input
                type="number"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="3500000"
              />
            </Field>
            <Field label="Source">
              <Select value={source} onChange={(event) => setSource(event.target.value)}>
                <option>Phone enquiry</option>
                <option>Walk-in</option>
                <option>Referral</option>
                <option>Repeat customer</option>
              </Select>
            </Field>
          </div>
        </div>
      </Card>

      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-ink-500">
          No co-applicant, guarantor or property here. Add them later, in one action, if they exist.
        </p>
        <Button variant="primary" disabled={!ready} onClick={submit} className={cx(!ready && "opacity-60")}>
          Open case
        </Button>
      </div>
    </div>
  );
}
