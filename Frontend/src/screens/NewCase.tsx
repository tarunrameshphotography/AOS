/**
 * Creating a case.
 *
 * WHAT THIS SCREEN IS FOR, AND WHAT IT IS NOT
 *
 * It captures the small set of facts the document requirement engine needs to
 * produce a correct checklist, and nothing else. It is not a data-entry form
 * for everything AOS knows about a customer — that is the person's profile,
 * filled over time — and it is not a substitute for the case screen, where
 * every answer here is correctable afterwards.
 *
 * THE DEFECT THIS FIXES. Until now the form asked for an applicant, a loan
 * type, an amount and a source. The engine, meanwhile, has been able to
 * distinguish salaried from self-employed since migration 0021, and the rule
 * pack has read that distinction properly since 0026 — payslips and Form 16 on
 * one side, ITR, Form 26AS, CA-certified accounts and GST returns on the other.
 * Nothing ever recorded which of the two the applicant was, so
 * `party.employment_type` resolved to unknown on every real case, every
 * income-conditioned rule matched nothing, and the login desk got KYC plus
 * whatever the product code alone could justify. The rules were right. Nobody
 * had told them anything.
 *
 * PROGRESSIVE DISCLOSURE, AND WHY IT IS NOT A STYLE CHOICE
 *
 * This form is filled DURING a phone call. Forty fields on screen is a form
 * the telecaller fills in afterwards from notes, which is the moment AOS stops
 * being used live and starts being a filing system. So: pick the loan type,
 * and only the questions that loan type can answer appear. A gold loan reveals
 * no business section, because a gold loan is underwritten on the ornaments.
 *
 * WHICH questions a loan type reveals is decided by WHAT THE PRODUCT DECLARES
 * — `employmentTypeIds`, `businessConstitutionIds`, `propertyRequirement`,
 * `gstRequirement`, all from the catalogue (ADR-032, migration 0015/0016) —
 * never by a list of product codes written into this file. A product added in
 * Master Data next year asks the right questions with no frontend change,
 * which is the same discipline that keeps the rule engine out of application
 * code.
 *
 * EVERY QUESTION IS OPTIONAL. A telecaller who does not yet know is not
 * blocked from opening a case: unanswered means "nobody has asked", the rules
 * already distinguish that from "no" (see `notExplicitlyNo` in
 * default-rules.ts), and the case screen takes the answer later. Requiring
 * them would trade a wrong checklist for an unopenable case.
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
import type { ApiCase, ApiCustomer, ApiReferenceItem } from "../api/types.js";
import { clearDrafts, useDraft } from "../fake/drafts.js";
import { useSession } from "../session.js";
import { Button, Card, Field, Input, PermissionCode, Select, cx, useToast } from "../ui/index.js";
import { CustomerSearchField } from "../ui/customer-picker.js";

/**
 * A yes / no / not-asked answer.
 *
 * THREE VALUES, NOT TWO, and the empty string is the important one. A checkbox
 * would make "nobody has asked" indistinguishable from "no", and the rules
 * read those differently on purpose: an unanswered GST question must not
 * generate a GST requirement, and an unanswered ITR question must not suppress
 * one. "Not asked" is the default because on a first call it is usually true.
 */
function TriStateField({
  label,
  hint,
  value,
  onChange,
  name,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  name: string;
}): ReactNode {
  return (
    <Field label={label} {...(hint ? { hint } : {})}>
      <Select name={name} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Not asked yet</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </Select>
    </Field>
  );
}

/** `""` stays out of the request body entirely — see the tri-state note above.
 * Sending `null` would record "we asked and there is no answer", which is a
 * different and wrong statement. */
function triState(value: string): boolean | undefined {
  if (value === "yes") return true;
  if (value === "no") return false;
  return undefined;
}

/** The master-data rows a product is actually offered to, in catalogue order.
 * An empty applicability list on the product means "no restriction recorded",
 * and the honest reading of that is every active type. */
function offered(
  all: readonly ApiReferenceItem[],
  allowedIds: readonly string[],
): readonly ApiReferenceItem[] {
  const active = all.filter((item) => item.isActive);
  if (allowedIds.length === 0) return active;
  return active.filter((item) => allowedIds.includes(item.id));
}

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
  const [draftEmploymentTypeId, setEmploymentTypeId] = useDraft("new-case:employment");
  const [draftConstitutionId, setConstitutionId] = useDraft("new-case:constitution");
  const [draftBorrowerTypeId, setBorrowerTypeId] = useDraft("new-case:borrower");
  const [gstRegistered, setGstRegistered] = useDraft("new-case:gst");
  const [itrFiled, setItrFiled] = useDraft("new-case:itr");
  const [existingObligations, setExistingObligations] = useDraft("new-case:obligations");
  const [chosen, setChosen] = useState<ApiCustomer | null>(null);

  // A drafted id the catalogue no longer offers is ignored rather than
  // selected — a deactivated product must not be revived by an old draft.
  const productId = reference.selectableProducts.some((p) => p.id === draftProductId)
    ? draftProductId
    : (reference.selectableProducts[0]?.id ?? "");
  const referralSourceId = reference.selectableSources.some((s) => s.id === draftSourceId)
    ? draftSourceId
    : (reference.selectableSources[0]?.id ?? "");

  const product = reference.productById(productId);

  // What this loan type can be asked about. Everything below reads these, so
  // "which questions appear" has exactly one answer and it comes from the
  // catalogue rather than from this file.
  const employmentOptions = offered(reference.employmentTypes, product?.employmentTypeIds ?? []);
  const constitutionOptions = offered(
    reference.businessConstitutions,
    product?.businessConstitutionIds ?? [],
  );
  const borrowerOptions = offered(reference.borrowerTypes, product?.borrowerTypeIds ?? []);

  // A drafted answer the newly-chosen loan type does not offer is dropped, not
  // submitted: switching from a Professional Loan to a Gold Loan must not
  // quietly carry "self-employed professional" onto a product that never
  // offered it.
  const employmentTypeId = employmentOptions.some((e) => e.id === draftEmploymentTypeId)
    ? draftEmploymentTypeId
    : "";
  const businessConstitutionId = constitutionOptions.some((c) => c.id === draftConstitutionId)
    ? draftConstitutionId
    : "";
  const borrowerTypeId = borrowerOptions.some((b) => b.id === draftBorrowerTypeId)
    ? draftBorrowerTypeId
    : "";

  const employmentCode = employmentOptions.find((e) => e.id === employmentTypeId)?.code;
  /** The three-way income split the whole income section of the rule pack
   * turns on. `self_employed` is the professional; `business_owner` runs a
   * business (`employment_type` master data, migration 0003). */
  const isSelfEmployed = employmentCode === "self_employed" || employmentCode === "business_owner";
  const runsABusiness = employmentCode === "business_owner";

  // The product's own declaration (ADR-032), not a product-code list.
  const takesProperty = product?.propertyRequirement !== "not_applicable";
  const gstCouldApply = product?.gstRequirement !== "not_applicable";

  /** Whether this loan is underwritten on the borrower's income at all. A gold
   * loan and a loan against securities are documented by the SECURITY — the
   * rule pack's `ASSET_ONLY_PRODUCTS` — so asking their customer how they earn
   * a living collects a fact nothing will read. */
  const assessesIncome = employmentOptions.length > 0;

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

      const gst = triState(gstRegistered);
      const itr = triState(itrFiled);
      const obligations = triState(existingObligations);

      return await api<ApiCase>("/cases", {
        method: "POST",
        body: {
          applicantId: applicant.id,
          loanProductId: productId,
          ...(amount ? { requestedAmount: Number(amount) } : {}),
          ...(referralSourceId ? { referralSourceId } : {}),
          // Each fact is OMITTED when unanswered rather than sent as null —
          // "nobody asked" and "asked, no answer" are different, and only the
          // first is true of a question the form never showed.
          ...(employmentTypeId ? { employmentTypeId } : {}),
          ...(businessConstitutionId ? { businessConstitutionId } : {}),
          ...(borrowerTypeId ? { borrowerTypeId } : {}),
          ...(gst === undefined ? {} : { isGstRegistered: gst }),
          ...(itr === undefined ? {} : { itrFiled: itr }),
          ...(obligations === undefined ? {} : { hasExistingObligations: obligations }),
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
          The applicant, the loan type, and the few facts that decide which documents to ask for.
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
              {reference.selectableProducts.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
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

      {/* Revealed by the loan type, never shown for a product that is
          underwritten on its security rather than on the borrower. */}
      {assessesIncome && (
        <Card
          title="How they earn"
          subtitle="This is what decides whether the checklist asks for payslips or for returns and accounts."
        >
          <div className="space-y-3">
            <Field
              label="Applicant type"
              hint="Leave unanswered if the call has not got there yet — the checklist fills in when you record it."
            >
              <Select
                name="employmentType"
                value={employmentTypeId}
                onChange={(event) => setEmploymentTypeId(event.target.value)}
              >
                <option value="">Not asked yet</option>
                {employmentOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            </Field>

            {borrowerOptions.length > 1 && (
              <Field
                label="Borrower type"
                hint="An NRI file needs a passport, a visa, overseas income proof and a power of attorney."
              >
                <Select
                  name="borrowerType"
                  value={borrowerTypeId}
                  onChange={(event) => setBorrowerTypeId(event.target.value)}
                >
                  <option value="">Not asked yet</option>
                  {borrowerOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            {/* Only a self-employed answer opens the returns question. A
                salaried applicant's Form 16 is the return, and asking them
                whether they file is a question with no consequence. */}
            {isSelfEmployed && (
              <TriStateField
                label="Files an income tax return?"
                hint="A 'no' stands the ITR requirement down. Anything else keeps asking for it — a self-employed file is assessed on it."
                name="itrFiled"
                value={itrFiled}
                onChange={setItrFiled}
              />
            )}

            <TriStateField
              label="Already repaying another loan?"
              hint="Drives the existing-loan statement — the obligations half of the affordability calculation."
              name="hasExistingObligations"
              value={existingObligations}
              onChange={setExistingObligations}
            />
          </div>
        </Card>
      )}

      {/* The business section: only for someone who runs a business, and only
          where the product has a GST or constitution dimension at all. */}
      {runsABusiness && (constitutionOptions.length > 0 || gstCouldApply) && (
        <Card
          title="About the business"
          subtitle="Which papers the business itself has to produce."
        >
          <div className="space-y-3">
            {constitutionOptions.length > 0 && (
              <Field
                label="Business type"
                hint="A partnership needs its deed, a company its incorporation certificate, MOA/AOA and a board resolution."
              >
                <Select
                  name="businessConstitution"
                  value={businessConstitutionId}
                  onChange={(event) => setConstitutionId(event.target.value)}
                >
                  <option value="">Not asked yet</option>
                  {constitutionOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            {gstCouldApply && (
              <TriStateField
                label="Registered under GST?"
                hint="A 'yes' asks for the registration certificate and the returns. A 'no' asks for neither."
                name="isGstRegistered"
                value={gstRegistered}
                onChange={setGstRegistered}
              />
            )}
          </div>
        </Card>
      )}

      {mutation.error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {mutation.error}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-xs text-ink-500">
          {takesProperty
            ? "No co-applicant, guarantor or property here — add them on the case, in one action, if they exist. A property-backed loan asks for its title papers once the property is on the file."
            : "No co-applicant or guarantor here. Add them later, in one action, if they exist."}
          <br />
          Every answer above is correctable on the case afterwards, and the checklist follows.
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
