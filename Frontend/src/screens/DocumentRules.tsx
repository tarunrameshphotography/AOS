/**
 * Document Rules administration (Milestone 9, ADR-035).
 *
 * The screen the milestone exists for: what AOS asks for is now data a
 * business user owns, not code a developer owns. Every document on every
 * case's checklist is generated from a row visible here.
 *
 * WHAT IS EDITABLE AND WHY THAT MUCH
 *
 * Four fields: how strongly the document is wanted, when it becomes due, how
 * many financial years of it, and why the rule exists. Those are the four a
 * loan manager has a settled opinion about, and each is safe in the sense
 * that getting it wrong produces a checklist that is visibly odd rather than
 * silently empty.
 *
 * A rule's CONDITIONS are shown in full but not edited here. Changing when a
 * rule fires is a different kind of decision from changing what it asks for,
 * and a single form that does both invites the accidental version of each —
 * the failure that ends with someone quietly switching off income proof for
 * every product. Conditions are edited in the schema-backed admin path
 * (Database/migrations/0021) and are a deliberate next step, not an oversight;
 * the shape they would be edited in is already here, read-only, so the
 * decision to build that editor can be made against something real.
 *
 * Rules are deactivated, never deleted — a requirement generated two years
 * ago names the rule that asked for it, and "why was this collected?" has to
 * stay answerable (BR-027's discipline, applied where it matters most).
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { CASE_STAGE_LABELS, CASE_STAGE_PROGRESSION } from "@domain/case/stages.js";
import type { ProgressionStage } from "@domain/case/stages.js";
import type { ApplicabilityCode } from "@domain/products/index.js";

import { api } from "../api/client.js";
import { useMutation } from "../api/hooks.js";
import { useDocumentRequirementRules, useDocumentTypes } from "../api/master-data.js";
import type { ApiDocumentRequirementRule, ApiRuleCondition } from "../api/types.js";
import { titleCase } from "../lib.js";
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
  useToast,
} from "../ui/index.js";

/**
 * Conditions, rendered as the sentence they are.
 *
 * "case.product_code in [hl_purchase, hl_nri]" is a rule an engineer can
 * read. "Lending product is one of Home Loan — Purchase, NRI Home Loan" is a
 * rule a loan manager can check. The screen owes the second, because a rule
 * nobody outside engineering can verify is a rule nobody outside engineering
 * will ever own.
 */
const FACT_LABELS: Record<string, string> = {
  "case.product_code": "Lending product",
  "case.customer_product_code": "Customer product",
  "case.security_type_code": "Security",
  "case.property_requirement": "Product's property requirement",
  "case.gst_requirement": "Product's GST requirement",
  "case.requested_amount": "Requested amount",
  "case.is_gst_registered": "Business is GST registered",
  "case.construction_stage": "Construction stage",
  "case.has_existing_obligations": "Has existing obligations",
  "case.has_collateral": "A property is on the file",
  "case.has_co_applicant": "Has a co-applicant",
  "case.has_guarantor": "Has a guarantor",
  "case.has_borrower_firm": "A borrowing firm is on the file",
  "party.role": "Party's role",
  "party.kind": "Party is a person or a firm",
  "party.employment_type": "Employment type",
  "party.business_constitution": "Business constitution",
  "party.borrower_type": "Borrower type",
  "party.is_gst_registered": "Party is GST registered",
  "party.has_existing_obligations": "Party has existing obligations",
  "party.is_primary": "Is the primary applicant",
  "property.role": "Property's role",
  "property.type": "Property type",
  "property.ownership_type": "Property ownership",
};

const OPERATOR_LABELS: Record<string, string> = {
  equals: "is",
  not_equals: "is not",
  in: "is one of",
  not_in: "is not one of",
  is_true: "is yes",
  is_false: "is no",
  exists: "has been answered",
  absent: "has not been answered",
  gte: "is at least",
  lte: "is at most",
};

function describeCondition(condition: ApiRuleCondition): string {
  const fact = FACT_LABELS[condition.fact] ?? condition.fact;
  const operator = OPERATOR_LABELS[condition.operator] ?? condition.operator;
  const values = (condition.values ?? []).map((value) => titleCase(String(value))).join(", ");
  return values ? `${fact} ${operator} ${values}` : `${fact} ${operator}`;
}

export function DocumentRules(): ReactNode {
  const session = useSession();
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<ApiDocumentRequirementRule | null>(null);

  const rulesQuery = useDocumentRequirementRules();
  const typesQuery = useDocumentTypes();

  if (!session.can("master_data.read", "all")) {
    return (
      <Card title="Document rules are not visible to this user">
        <p className="text-sm text-ink-700">
          This role holds no <code>master_data.read</code>. What AOS asks a customer for is a
          business policy, and changing it is a business decision with consequences on every open
          case.
        </p>
      </Card>
    );
  }

  const canEdit = session.can("master_data.manage", "all");

  const rules = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rulesQuery.rules
      .filter((rule) => showInactive || rule.isActive)
      .filter((rule) => {
        if (!q) return true;
        const documentTypeName = typesQuery.nameForCode(rule.documentTypeCode);
        const haystack = [
          rule.name,
          rule.code,
          rule.documentTypeCode,
          documentTypeName,
          rule.notes ?? "",
          ...rule.conditions.map(describeCondition),
        ]
          .join(" ")
          .toLowerCase();
        return q.split(/\s+/).every((word) => haystack.includes(word));
      })
      .sort((a, b) => a.displayOrder - b.displayOrder);
  }, [rulesQuery.rules, typesQuery, query, showInactive]);

  const active = rulesQuery.rules.filter((rule) => rule.isActive).length;

  return (
    <div className="space-y-6">
      <Card
        title="Document rules"
        subtitle={`${active} rules in service — reads and writes AOS's office database.`}
      >
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="GST · patta · salaried · partnership · valuation"
            className="min-w-64 flex-1 rounded-md bg-ink-50 px-3 py-1.5 text-sm ring-1 ring-ink-200 focus:bg-white focus:ring-2 focus:ring-brand-500 focus:outline-none"
          />
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(event) => setShowInactive(event.target.checked)}
            />
            Show rules out of service
          </label>
        </div>

        <p className="mt-3 text-xs text-ink-500">
          Real case checklists are generated server-side (<code>Backend/requirements.ts</code>) from
          exactly these rules — a change saved here takes effect the next time a case's checklist is
          computed.
        </p>
      </Card>

      <Card title={`${rules.length} matching`}>
        {rules.length === 0 ? (
          <Empty>Nothing matches. Try a document name, a product, or a condition.</Empty>
        ) : (
          <ul className="divide-y divide-ink-100">
            {rules.map((rule) => {
              const documentTypeName = typesQuery.nameForCode(rule.documentTypeCode);
              return (
                <li key={rule.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{rule.name}</span>
                        <Badge tone={rule.applicability === "mandatory" ? "info" : "neutral"}>
                          {titleCase(rule.applicability)}
                        </Badge>
                        <Badge>{titleCase(rule.scope)}</Badge>
                        {rule.financialYears && (
                          <Badge tone="warn">
                            {rule.financialYears} financial{" "}
                            {rule.financialYears === 1 ? "year" : "years"}
                          </Badge>
                        )}
                        {!rule.isActive && <Badge tone="bad">Out of service</Badge>}
                      </div>

                      <p className="mt-0.5 text-xs text-ink-500">
                        Asks for <strong className="font-medium">{documentTypeName}</strong>
                        {rule.partyRoles && rule.partyRoles.length > 0 && (
                          <> · of the {rule.partyRoles.map((role) => titleCase(role)).join(", ")}</>
                        )}
                        {" · due from "}
                        {CASE_STAGE_LABELS[rule.applicableFromStage]}
                      </p>

                      {rule.conditions.length === 0 ? (
                        <p className="mt-1 text-xs text-ink-400">
                          Unconditional — asked for on every case this scope applies to.
                        </p>
                      ) : (
                        <ul className="mt-1 space-y-0.5">
                          {rule.conditions.map((condition, index) => (
                            <li key={index} className="text-xs text-ink-600">
                              <span className="text-ink-400">
                                {index === 0 ? "When " : rule.match === "any" ? "or " : "and "}
                              </span>
                              {describeCondition(condition)}
                            </li>
                          ))}
                        </ul>
                      )}

                      {rule.notes && <p className="mt-1 text-xs text-ink-500">{rule.notes}</p>}
                    </div>

                    {canEdit && (
                      <div className="flex shrink-0 gap-1.5">
                        <Button onClick={() => setEditing(rule)}>Edit</Button>
                        <ToggleButton rule={rule} onSaved={rulesQuery.refetch} />
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <EditRuleDialog rule={editing} onClose={() => setEditing(null)} onSaved={rulesQuery.refetch} />
    </div>
  );
}

function ToggleButton({
  rule,
  onSaved,
}: {
  rule: ApiDocumentRequirementRule;
  onSaved: () => void;
}): ReactNode {
  const toast = useToast();
  const mutation = useMutation();

  return (
    <Button
      variant="ghost"
      disabled={mutation.pending}
      onClick={async () => {
        const result = await mutation.run(() =>
          api(`/master-data/document-rules/${rule.id}/active`, {
            method: "PUT",
            body: { isActive: !rule.isActive },
          }),
        );
        if (result === undefined) {
          toast.show(mutation.error ?? "Could not update.", "bad");
          return;
        }
        toast.show(
          rule.isActive
            ? `${rule.name} taken out of service. Nothing already collected under it is lost.`
            : `${rule.name} returned to service.`,
        );
        onSaved();
      }}
    >
      {rule.isActive ? "Take out of service" : "Return to service"}
    </Button>
  );
}

function EditRuleDialog({
  rule,
  onClose,
  onSaved,
}: {
  rule: ApiDocumentRequirementRule | null;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const toast = useToast();
  const mutation = useMutation();

  const [name, setName] = useState("");
  const [applicability, setApplicability] = useState<ApplicabilityCode>("mandatory");
  const [stage, setStage] = useState<ProgressionStage>("documents_pending");
  const [years, setYears] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!rule) return;
    setName(rule.name);
    setApplicability(rule.applicability);
    setStage(rule.applicableFromStage);
    setYears(rule.financialYears ? String(rule.financialYears) : "");
    setNotes(rule.notes ?? "");
  }, [rule]);

  if (!rule) return null;

  return (
    <Modal open={rule !== null} title="Edit rule" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name" hint="What someone else will read in this list a year from now.">
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>

        <Field
          label="How strongly is it wanted?"
          hint="Optional documents are collected and verified like any other, but never counted against the case — an optional document nobody chased must not hold a complete file at 94%."
        >
          <Select
            value={applicability}
            onChange={(event) => setApplicability(event.target.value)}
          >
            <option value="mandatory">Mandatory</option>
            <option value="optional">Optional</option>
            <option value="not_applicable">
              Not applicable — keep the rule, ask for nothing
            </option>
          </Select>
        </Field>

        <Field
          label="Due from"
          hint="A valuation demanded before a property is chosen makes the checklist wrong and the progress bar useless. Later-stage requirements are shown as upcoming, never as missing."
        >
          <Select
            value={stage}
            onChange={(event) => setStage(event.target.value as ProgressionStage)}
          >
            {CASE_STAGE_PROGRESSION.map((value) => (
              <option key={value} value={value}>
                {CASE_STAGE_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Financial years"
          hint="For recurring documents only — ITR, GST returns, financials, banking. Each year becomes its own row, because one year's filing must never stand in for another's. Leave blank for a one-off document."
        >
          <Input
            type="number"
            min={0}
            max={10}
            value={years}
            onChange={(event) => setYears(event.target.value)}
          />
        </Field>

        <Field label="Why this rule exists" hint="Read by people, never parsed by anything.">
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>

        <div className="rounded-md bg-ink-50 p-3">
          <p className="text-xs font-medium text-ink-700">When it fires</p>
          {rule.conditions.length === 0 ? (
            <p className="text-xs text-ink-500">
              Unconditional. Asked for on every case this scope applies to.
            </p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {rule.conditions.map((condition, index) => (
                <li key={index} className="text-xs text-ink-600">
                  {describeCondition(condition)}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1.5 text-xs text-ink-400">
            Conditions are not edited here. Changing when a rule fires is a different decision from
            changing what it asks for, and one form that did both would invite the accidental
            version of each.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={mutation.pending}
            onClick={async () => {
              const parsed = Number(years);
              const result = await mutation.run(() =>
                api(`/master-data/document-rules/${rule.id}`, {
                  method: "PUT",
                  body: {
                    name,
                    applicability,
                    applicableFromStage: stage,
                    financialYears: years && parsed > 0 ? parsed : undefined,
                    notes,
                  },
                }),
              );
              if (result === undefined) {
                toast.show(mutation.error ?? "Could not save.", "bad");
                return;
              }
              toast.show("Rule saved. Open cases pick it up when they next change.");
              onSaved();
              onClose();
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
