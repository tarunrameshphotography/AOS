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

import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { createCase } from "../fake/store.js";
import { useDatabase } from "../fake/useDatabase.js";
import { useSession } from "../session.js";
import { Button, Card, Field, Input, Select, cx, useToast } from "../ui/index.js";
import { PersonSearchField } from "../ui/pickers.js";

export function NewCase(): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const navigate = useNavigate();
  const toast = useToast();

  const activeReferralSources = db.referralSources
    .filter((r) => r.isActive)
    .sort((a, b) => a.displayOrder - b.displayOrder);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [productId, setProductId] = useState(db.loanProducts[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [referralSourceId, setReferralSourceId] = useState(activeReferralSources[0]?.id ?? "");
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

  const submit = (): void => {
    const caseId = createCase(
      {
        ...(chosenPersonId ? { applicantPersonId: chosenPersonId } : {}),
        ...(chosenPersonId ? {} : { newApplicantName: name.trim(), newApplicantPhone: phone.trim() }),
        loanProductId: productId,
        ...(amount ? { requestedAmount: Number(amount) } : {}),
        ...(referralSourceId ? { referralSourceId } : {}),
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
        <PersonSearchField
          db={db}
          name={name}
          phone={phone}
          chosenPersonId={chosenPersonId}
          onNameChange={setName}
          onPhoneChange={setPhone}
          onChoose={setChosenPersonId}
          chosenHint="Their KYC carries over. This case will open with those requirements already satisfied."
        />
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
            <Field label="Source" hint="Configurable in Master Data — Administration workspace.">
              <Select
                value={referralSourceId}
                onChange={(event) => setReferralSourceId(event.target.value)}
              >
                {activeReferralSources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
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
