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
 * customer is the moment the system visibly beats memory. As of Stage 3B that
 * check runs against PostgreSQL rather than the browser's own copy, so it sees
 * every customer the company has, not the ones this tab happened to load.
 *
 * TWO REQUESTS, ONE ACT. A brand-new applicant is created first and the case
 * second. They are not one transaction, and the failure that implies is worth
 * being honest about: if the case call fails, the customer exists with no case.
 * That leaves a searchable person and a telecaller who retries — recoverable,
 * and better than the alternative of inventing a combined endpoint whose only
 * caller is this form. An existing applicant skips the first call entirely.
 */

import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../api/client.js";
import { useReference } from "../api/catalogue.js";
import { useMutation } from "../api/hooks.js";
import type { ApiCase, ApiCustomer } from "../api/types.js";
import { clearDrafts, useDraft } from "../fake/drafts.js";
import { useSession } from "../session.js";
import { Button, Card, Field, Input, PermissionCode, Select, cx, useToast } from "../ui/index.js";
import { CustomerSearchField } from "../ui/customer-picker.js";

export function NewCase(): ReactNode {
  const session = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const reference = useReference();
  const mutation = useMutation();

  /**
   * Drafted, not merely typed (Telecaller Workflow milestone, Part 7).
   *
   * This form is filled DURING a phone call, and a call is exactly when
   * somebody navigates away mid-form to look something up. Losing the
   * applicant's name at that moment teaches a telecaller to write the details
   * on paper first and type them in afterwards, which is how a system stops
   * being used live. The drafts stay in localStorage deliberately: an
   * unsubmitted form is not case data, and round-tripping every keystroke to
   * the server would be worse in every way.
   */
  const [name, setName] = useDraft("new-case:name");
  const [phone, setPhone] = useDraft("new-case:phone");
  const [draftProductId, setProductId] = useDraft("new-case:product");
  const [amount, setAmount] = useDraft("new-case:amount");
  const [draftSourceId, setReferralSourceId] = useDraft("new-case:source");
  const [chosen, setChosen] = useState<ApiCustomer | null>(null);

  // A drafted id the catalogue no longer offers is ignored rather than
  // selected — a deactivated product must not be revived by an old draft.
  const productId = reference.selectableProducts.some((p) => p.id === draftProductId)
    ? draftProductId
    : (reference.selectableProducts[0]?.id ?? "");
  const referralSourceId = reference.selectableSources.some((s) => s.id === draftSourceId)
    ? draftSourceId
    : (reference.selectableSources[0]?.id ?? "");

  if (!session.can("case.create", "all")) {
    return (
      <Card title="Not permitted">
        <p className="text-sm text-ink-700">You don't have access to open a new case.</p>
        <PermissionCode code="case.create" />
      </Card>
    );
  }

  const submit = async (): Promise<void> => {
    const created = await mutation.run(async () => {
      const applicant =
        chosen ??
        (await api<ApiCustomer>("/customers", {
          method: "POST",
          body: { fullName: name.trim(), phone: phone.trim() },
        }));

      return await api<ApiCase>("/cases", {
        method: "POST",
        body: {
          applicantId: applicant.id,
          loanProductId: productId,
          ...(amount ? { requestedAmount: Number(amount) } : {}),
          ...(referralSourceId ? { referralSourceId } : {}),
        },
      });
    });

    if (!created) return;

    // The draft has become a case. Leaving it behind would greet the next new
    // case with the last one's applicant already typed in.
    clearDrafts("new-case:");
    toast.show("Case opened. Its number was allocated straight away — quotable on this call.");
    navigate(`/cases/${created.id}`);
  };

  const hasApplicant = chosen !== null || name.trim().length > 1;
  const ready = productId !== "" && hasApplicant && !mutation.pending;
  // Same conditions `ready` checks, in the order a telecaller would fix them —
  // the button going quietly unresponsive is the actual complaint this answers.
  const readyReason = !hasApplicant
    ? "Add a customer name to open this case."
    : productId === ""
      ? reference.loading
        ? "Loading loan types…"
        : "No loan type is set up to choose from yet."
      : null;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">New case</h1>
        <p className="mt-1 text-sm text-ink-500">
          The applicant and the loan type. Everything else is added when reality supplies it.
        </p>
      </div>

      <Card title="Who is applying">
        <CustomerSearchField
          name={name}
          phone={phone}
          chosen={chosen}
          onNameChange={setName}
          onPhoneChange={setPhone}
          onChoose={setChosen}
          chosenHint="Their details carry over. This case opens against the record AOS already holds."
        />
      </Card>

      <Card title="What they want">
        <div className="space-y-3">
          <Field
            label="Loan type"
            hint="Known at creation, before any bank is chosen — which is what makes the requirement list possible."
          >
            <Select
              name="loanProduct"
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
            >
              {reference.selectableProducts.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Amount" hint="Rough is fine.">
              <Input
                type="number"
                name="requestedAmount"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="3500000"
              />
            </Field>
            <Field label="Source" hint="Configurable in Master Data — Administration workspace.">
              <Select
                name="referralSource"
                value={referralSourceId}
                onChange={(event) => setReferralSourceId(event.target.value)}
              >
                {reference.selectableSources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
      </Card>

      {mutation.error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {mutation.error}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-xs text-ink-500">
          No co-applicant, guarantor or property here. Add them later, in one action, if they exist.
          <br />
          Nothing typed here is lost if you navigate away — it is kept until the case is opened.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => navigate(-1)}>
            Back
          </Button>
          <Button
            onClick={() => {
              clearDrafts("new-case:");
              setChosen(null);
              toast.show("Cleared.");
            }}
          >
            Clear
          </Button>
          <div className="flex flex-col items-end gap-1">
            <Button
              variant="primary"
              disabled={!ready}
              onClick={() => void submit()}
              className={cx(!ready && "opacity-60")}
            >
              {mutation.pending ? "Opening…" : "Open case"}
            </Button>
            {readyReason ? (
              <p className="text-xs text-amber-700" role="status">
                {readyReason}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
