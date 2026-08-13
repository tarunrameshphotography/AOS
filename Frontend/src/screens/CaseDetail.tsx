/**
 * The case screen — the centre of the system.
 *
 * ============================================================================
 * STAGE 3B REWROTE THIS FILE, AND THE REASON MATTERS
 * ============================================================================
 *
 * The previous version was 4,878 lines across about thirty components, and
 * every one of them read the prototype store synchronously. It rendered the
 * case together with its documents, requirements, submissions, parties,
 * properties, notes and timeline — a case is the spine those hang off, which
 * is exactly what made it the best screen in the prototype.
 *
 * That spine is what broke the partial migration. A case now lives in
 * PostgreSQL with a uuid; documents, requirements and submissions still live
 * in the prototype store keyed by ids it minted itself. They cannot be joined,
 * and no amount of care makes them line up: the migrated case genuinely has no
 * documents, because documents have not moved.
 *
 * Two ways out were on the table. Mirror the API case back into the prototype
 * store so the old tabs keep rendering — which reintroduces exactly the second
 * source of truth this stage exists to remove. Or show the case honestly, from
 * the server, and say plainly that the rest is not here yet. This is the
 * second. The Overview tab is fully live on PostgreSQL; Documents, Banks and
 * Timeline say what they are waiting for.
 *
 * The previous implementation is not lost — it is at commit 37678ab, and the
 * later stages that migrate documents, submissions and the timeline port their
 * UI from there rather than reinventing it.
 *
 * ============================================================================
 *
 * WHAT DID NOT CHANGE: everything that can be refused is refused by the
 * server, and the refusal's own words are shown. "This case is on hold" or "a
 * case cannot move from new to documents_pending" is more useful than a
 * disabled button — the same principle the prototype followed, now with the
 * refusals coming from where they are actually enforced.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import {
  CASE_STAGE_LABELS,
  LOST_REASONS,
  LOST_REASON_LABELS,
  type CaseStage,
  type LostReason,
} from "@domain/case/stages.js";
import { userSelectableStages } from "@domain/case/transitions.js";
import {
  DOCUMENT_CATALOGUE,
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_HINTS,
  DOCUMENT_CATEGORY_LABELS,
  documentRowLabel,
  financialYearOf,
  type DocumentCategory,
} from "@domain/requirements/index.js";

import { api, apiDownload, apiUpload } from "../api/client.js";
import { useReference, useUsers } from "../api/catalogue.js";
import { useApiQuery, useMutation } from "../api/hooks.js";
import type {
  ApiCase,
  ApiCaseParty,
  ApiCaseProperty,
  ApiCaseRequirements,
  ApiCustomer,
  ApiRequirement,
  ApiTimelineEntry,
  CasePartyRole,
  CasePropertyRole,
} from "../api/types.js";
import { bytes, exactly, lakhs, money, when } from "../lib.js";
import { useSession } from "../session.js";
import { BanksTab } from "./BanksTab.js";
import { documentPreviewMode, previewFallbackMessage } from "./document-preview.js";
import {
  CASE_TABS,
  CASE_TAB_LABELS,
  CASE_TAB_PURPOSE,
  resolveCaseTab,
  type CaseTab,
} from "./case-tabs.js";
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Modal,
  PermissionCode,
  ProgressBar,
  Select,
  StageBadge,
  StageRail,
  Textarea,
  cx,
  useToast,
} from "../ui/index.js";
import { CustomerSearchField } from "../ui/customer-picker.js";

export function CaseDetail(): ReactNode {
  const { caseId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = resolveCaseTab(searchParams.get("tab"));

  const query = useApiQuery<ApiCase>(caseId ? `/cases/${caseId}` : null);

  if (query.loading) return <Empty>Loading case…</Empty>;

  // The server answers 404 both for "no such case" and "not yours to see", so
  // a Telecaller probing a colleague's case URL learns nothing from the
  // difference. The screen repeats that answer rather than second-guessing it.
  if (query.error || !query.data) {
    return (
      <Card title="Not available">
        <p className="text-sm text-ink-700">
          {query.error?.message ?? "No such case, or you do not have access to it."}
        </p>
        {query.error?.isRefusal && <PermissionCode code="case.read" />}
        <p className="mt-3">
          <Link to="/cases" className="text-sm text-brand-600 hover:underline">
            Back to cases
          </Link>
        </p>
      </Card>
    );
  }

  const loanCase = query.data;

  return (
    <div className="space-y-4">
      <CaseHeader loanCase={loanCase} onChanged={query.refetch} />

      <div className="border-b border-ink-200">
        <div className="flex items-center gap-1">
          {CASE_TABS.map((value) => (
            <button
              key={value}
              onClick={() => {
                // The tab lives in the URL so the back button walks through
                // the sections and "this case's documents" is a link somebody
                // can send. The case id comes from the path and is never
                // rewritten here, so switching tabs cannot load another case.
                const next = new URLSearchParams(searchParams);
                next.set("tab", value);
                setSearchParams(next, { replace: true });
              }}
              className={cx(
                "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                tab === value
                  ? "border-brand-600 text-ink-900"
                  : "border-transparent text-ink-500 hover:text-ink-700",
              )}
            >
              {CASE_TAB_LABELS[value]}
              {value === "banks" && loanCase.stage === "ready_for_submission" && (
                <span
                  className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-sky-500"
                  title="Ready for submission — add a bank and send"
                />
              )}
            </button>
          ))}
          <span className="ml-3 text-xs text-ink-500">{CASE_TAB_PURPOSE[tab]}</span>
        </div>
      </div>

      {tab === "overview" && <Overview loanCase={loanCase} onChanged={query.refetch} />}
      {tab === "documents" && <DocumentsTab loanCase={loanCase} onCaseChanged={query.refetch} />}
      {tab === "banks" && <BanksTab loanCase={loanCase} onCaseChanged={query.refetch} />}
      {tab === "timeline" && <TimelineTab loanCase={loanCase} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header — who, what, how much, and where it stands
// ---------------------------------------------------------------------------

function CaseHeader({
  loanCase,
  onChanged,
}: {
  loanCase: ApiCase;
  onChanged: () => void;
}): ReactNode {
  const reference = useReference();
  const users = useUsers();
  const session = useSession();

  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-display tnum text-xl font-semibold tracking-tight text-ink-900">
            {loanCase.caseNumber}
          </h1>
          <StageBadge stage={loanCase.stage} label={CASE_STAGE_LABELS[loanCase.stage]} />
          {loanCase.isOnHold && <Badge tone="warn">On hold</Badge>}
        </div>

        <div className="mt-2 max-w-xs">
          <StageRail stage={loanCase.stage} />
        </div>

        <p className="mt-1 text-sm text-ink-700">
          {loanCase.applicantId ? (
            <Link to={`/people/${loanCase.applicantId}`} className="font-medium hover:underline">
              {loanCase.applicantName}
            </Link>
          ) : (
            <span className="text-ink-400">No applicant</span>
          )}
          {loanCase.applicantPhone && (
            <span className="tnum text-ink-500"> · {loanCase.applicantPhone}</span>
          )}
        </p>

        <p className="mt-0.5 text-sm text-ink-500">
          {reference.productLabel(loanCase.loanProductId)} ·{" "}
          <span className="tnum">{lakhs(loanCase.requestedAmount ?? undefined)}</span>
        </p>

        <p className="mt-1 text-xs text-ink-500">
          Currently with {users.ownerName(loanCase.ownerUserId)}
          {loanCase.createdByUserId && loanCase.createdByUserId !== loanCase.ownerUserId && (
            <> · brought in by {users.ownerName(loanCase.createdByUserId)}</>
          )}{" "}
          · opened {when(loanCase.createdAt)}
        </p>

        {loanCase.isOnHold && loanCase.holdReason && (
          <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
            On hold — {loanCase.holdReason}
            {loanCase.holdUntil && ` (until ${loanCase.holdUntil})`}
          </p>
        )}

        {loanCase.stage === "lost" && (
          <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-900">
            Lost{loanCase.lostReason ? ` — ${LOST_REASON_LABELS[loanCase.lostReason]}` : ""}
            {loanCase.lostNote && `: ${loanCase.lostNote}`}
            {loanCase.lostAt && ` · ${exactly(loanCase.lostAt)}`}
          </p>
        )}
      </div>

      <CaseActions loanCase={loanCase} onChanged={onChanged} session={session} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The verbs
// ---------------------------------------------------------------------------

function CaseActions({
  loanCase,
  onChanged,
  session,
}: {
  loanCase: ApiCase;
  onChanged: () => void;
  session: ReturnType<typeof useSession>;
}): ReactNode {
  const [open, setOpen] = useState<"stage" | "hold" | "lost" | "owner" | null>(null);

  // Every one of these mirrors a permission the server checks. Hiding a button
  // the server would refuse is a courtesy; the server refusing it is the
  // control (BR-060).
  const mayMove = session.canActOnCase(loanCase.ownerUserId, "case.update");
  const mayHold = session.canActOnCase(loanCase.ownerUserId, "case.hold");
  const mayLose = session.canActOnCase(loanCase.ownerUserId, "case.mark_lost");
  const mayReopen = session.canActOnCase(loanCase.ownerUserId, "case.reopen");
  const mayAssign = session.canActOnCase(loanCase.ownerUserId, "case.assign");

  const isLost = loanCase.stage === "lost";

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {!isLost && mayMove && (
          <Button onClick={() => setOpen("stage")}>Move stage</Button>
        )}
        {!isLost && mayHold && (
          <Button onClick={() => setOpen("hold")}>
            {loanCase.isOnHold ? "Release hold" : "Put on hold"}
          </Button>
        )}
        {!isLost && mayLose && (
          <Button onClick={() => setOpen("lost")}>Mark lost</Button>
        )}
        {isLost && mayReopen && <ReopenButton loanCase={loanCase} onChanged={onChanged} />}
        {mayAssign && <Button onClick={() => setOpen("owner")}>Reassign</Button>}
      </div>

      {open === "stage" && (
        <MoveStageModal loanCase={loanCase} onClose={() => setOpen(null)} onChanged={onChanged} />
      )}
      {open === "hold" && (
        <HoldModal loanCase={loanCase} onClose={() => setOpen(null)} onChanged={onChanged} />
      )}
      {open === "lost" && (
        <LostModal loanCase={loanCase} onClose={() => setOpen(null)} onChanged={onChanged} />
      )}
      {open === "owner" && (
        <OwnerModal loanCase={loanCase} onClose={() => setOpen(null)} onChanged={onChanged} />
      )}
    </>
  );
}

function ReopenButton({
  loanCase,
  onChanged,
}: {
  loanCase: ApiCase;
  onChanged: () => void;
}): ReactNode {
  const mutation = useMutation();
  const toast = useToast();

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="primary"
        disabled={mutation.pending}
        onClick={async () => {
          const result = await mutation.run(() =>
            api<ApiCase>(`/cases/${loanCase.id}/reopen`, { method: "POST" }),
          );
          if (result) {
            // Back where it was, not back to the beginning — a postponed
            // customer returning does not restart the conversation.
            toast.show(`Reopened at ${CASE_STAGE_LABELS[result.stage]}.`);
            onChanged();
          }
        }}
      >
        Reopen
      </Button>
      {mutation.error && (
        <p className="text-xs text-red-700" role="alert">
          {mutation.error}
        </p>
      )}
    </div>
  );
}

function MoveStageModal({
  loanCase,
  onClose,
  onChanged,
}: {
  loanCase: ApiCase;
  onClose: () => void;
  onChanged: () => void;
}): ReactNode {
  const mutation = useMutation();
  const toast = useToast();
  const options = userSelectableStages(loanCase.stage);
  const [stage, setStage] = useState<CaseStage>(options[0] ?? loanCase.stage);

  if (options.length === 0) {
    return (
      <Modal open title="Move stage" onClose={onClose}>
        <div className="space-y-3">
          <p className="text-sm text-ink-700">
            {loanCase.stage === "ready_for_submission"
              ? "This case is ready for submission. It moves to Submitted automatically once it's sent to a bank — that workflow isn't available here yet."
              : `There is nothing to choose here — ${CASE_STAGE_LABELS[loanCase.stage]} only advances automatically, by what happens on the case.`}
          </p>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open title="Move stage" onClose={onClose}>
      <div className="space-y-3">
        <Field
          label="Move to"
          hint="The server judges the move. Some stages are reached automatically by what happens on the case, not by choosing them here."
        >
          <Select value={stage} onChange={(event) => setStage(event.target.value as CaseStage)}>
            {options.map((value) => (
              <option key={value} value={value}>
                {CASE_STAGE_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>

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
            disabled={mutation.pending || stage === loanCase.stage}
            onClick={async () => {
              const result = await mutation.run(() =>
                api<ApiCase>(`/cases/${loanCase.id}/stage`, {
                  method: "PUT",
                  body: { stage },
                }),
              );
              if (result) {
                toast.show(`Moved to ${CASE_STAGE_LABELS[result.stage]}.`);
                onChanged();
                onClose();
              }
            }}
          >
            Move
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function HoldModal({
  loanCase,
  onClose,
  onChanged,
}: {
  loanCase: ApiCase;
  onClose: () => void;
  onChanged: () => void;
}): ReactNode {
  const mutation = useMutation();
  const toast = useToast();
  const [reason, setReason] = useState(loanCase.holdReason ?? "");
  const [until, setUntil] = useState(loanCase.holdUntil ?? "");
  const releasing = loanCase.isOnHold;

  return (
    <Modal open title={releasing ? "Release hold" : "Put this case on hold"} onClose={onClose}>
      <div className="space-y-3">
        {releasing ? (
          <p className="text-sm text-ink-700">
            The case goes back to {CASE_STAGE_LABELS[loanCase.stage]} and can be moved on again.
          </p>
        ) : (
          <>
            <Field
              label="Why"
              hint="A hold with no reason is indistinguishable from a forgotten case — the server refuses one."
            >
              <Textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
                placeholder="Customer travelling until March"
              />
            </Field>
            <Field label="Until" hint="Optional.">
              <Input
                type="date"
                value={until}
                onChange={(event) => setUntil(event.target.value)}
              />
            </Field>
          </>
        )}

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
            disabled={mutation.pending || (!releasing && reason.trim().length === 0)}
            onClick={async () => {
              const result = await mutation.run(() =>
                api<ApiCase>(`/cases/${loanCase.id}/hold`, {
                  method: "PUT",
                  body: releasing
                    ? { isOnHold: false }
                    : { isOnHold: true, holdReason: reason.trim(), holdUntil: until || null },
                }),
              );
              if (result) {
                toast.show(releasing ? "Hold released." : "Case put on hold.");
                onChanged();
                onClose();
              }
            }}
          >
            {releasing ? "Release" : "Put on hold"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function LostModal({
  loanCase,
  onClose,
  onChanged,
}: {
  loanCase: ApiCase;
  onClose: () => void;
  onChanged: () => void;
}): ReactNode {
  const mutation = useMutation();
  const toast = useToast();
  const [reason, setReason] = useState<LostReason>(LOST_REASONS[0]);
  const [note, setNote] = useState("");

  return (
    <Modal open title="Mark this case lost" onClose={onClose}>
      <div className="space-y-3">
        <Field
          label="Why was it lost"
          hint="A code rather than free text: 'why do we lose cases' is a question the business answers by counting, and free text cannot be counted."
        >
          <Select
            value={reason}
            onChange={(event) => setReason(event.target.value as LostReason)}
          >
            {LOST_REASONS.map((value) => (
              <option key={value} value={value}>
                {LOST_REASON_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Anything worth recording" hint="Optional. The bank and the rate, usually.">
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            placeholder="Went with HDFC at 8.4%"
          />
        </Field>

        <p className="text-xs text-ink-500">
          The case keeps the stage it reached, so reopening it later puts it back where it was.
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
              const result = await mutation.run(() =>
                api<ApiCase>(`/cases/${loanCase.id}/lost`, {
                  method: "PUT",
                  body: { lostReason: reason, lostNote: note.trim() || null },
                }),
              );
              if (result) {
                toast.show("Marked lost.");
                onChanged();
                onClose();
              }
            }}
          >
            Mark lost
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function OwnerModal({
  loanCase,
  onClose,
  onChanged,
}: {
  loanCase: ApiCase;
  onClose: () => void;
  onChanged: () => void;
}): ReactNode {
  const mutation = useMutation();
  const users = useUsers();
  const toast = useToast();
  const [ownerUserId, setOwnerUserId] = useState(loanCase.ownerUserId);

  return (
    <Modal open title="Reassign this case" onClose={onClose}>
      <div className="space-y-3">
        <Field
          label="Hand it to"
          hint="Only active employees. Assigning a case to a deactivated account is how a case becomes nobody's."
        >
          <Select
            value={ownerUserId}
            onChange={(event) => setOwnerUserId(event.target.value)}
          >
            {users.activeUsers.map((user) => (
              <option key={user.id} value={user.id}>
                {user.fullName}
              </option>
            ))}
          </Select>
        </Field>

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
            disabled={mutation.pending || ownerUserId === loanCase.ownerUserId}
            onClick={async () => {
              const result = await mutation.run(() =>
                api<ApiCase>(`/cases/${loanCase.id}/owner`, {
                  method: "PUT",
                  body: { ownerUserId },
                }),
              );
              if (result) {
                toast.show(`Reassigned to ${users.ownerName(result.ownerUserId)}.`);
                onChanged();
                onClose();
              }
            }}
          >
            Reassign
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function Overview({
  loanCase,
  onChanged,
}: {
  loanCase: ApiCase;
  onChanged: () => void;
}): ReactNode {
  const session = useSession();
  const reference = useReference();
  const mutation = useMutation();
  const toast = useToast();

  const mayEdit = session.canActOnCase(loanCase.ownerUserId, "case.update");
  const [amount, setAmount] = useState(
    loanCase.requestedAmount === null ? "" : String(loanCase.requestedAmount),
  );
  const [sourceId, setSourceId] = useState(loanCase.referralSourceId ?? "");

  const dirty =
    amount !== (loanCase.requestedAmount === null ? "" : String(loanCase.requestedAmount)) ||
    sourceId !== (loanCase.referralSourceId ?? "");

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card title="What this case is asking for">
          <div className="space-y-3">
            <Field label="Amount" hint="Rough is fine. It is what the customer asked for, not an offer.">
              <Input
                type="number"
                name="requestedAmount"
                value={amount}
                disabled={!mayEdit}
                onChange={(event) => setAmount(event.target.value)}
              />
            </Field>
            <Field label="Source" hint="How this lead reached Amaze.">
              <Select
                name="referralSource"
                value={sourceId}
                disabled={!mayEdit}
                onChange={(event) => setSourceId(event.target.value)}
              >
                <option value="">—</option>
                {reference.selectableSources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </Select>
            </Field>

            {!mayEdit && (
              <div>
                <p className="text-xs text-ink-500">
                  You can see this case but not change it.
                </p>
                <PermissionCode code="case.update" />
              </div>
            )}

            {mutation.error && (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
                {mutation.error}
              </p>
            )}

            {mayEdit && (
              <div className="flex justify-end">
                <Button
                  variant="primary"
                  disabled={!dirty || mutation.pending}
                  onClick={async () => {
                    const result = await mutation.run(() =>
                      api<ApiCase>(`/cases/${loanCase.id}`, {
                        method: "PATCH",
                        body: {
                          requestedAmount: amount === "" ? null : Number(amount),
                          referralSourceId: sourceId || null,
                        },
                      }),
                    );
                    if (result) {
                      toast.show("Saved.");
                      onChanged();
                    }
                  }}
                >
                  Save
                </Button>
              </div>
            )}
          </div>
        </Card>

        <PartiesCard loanCase={loanCase} />
        <PropertiesCard loanCase={loanCase} />
      </div>

      <div className="space-y-4">
        <Card title="Facts">
          <dl className="space-y-2 text-sm">
            <Fact label="Case number" value={loanCase.caseNumber} mono />
            <Fact label="Product" value={reference.productLabel(loanCase.loanProductId)} />
            <Fact
              label="Requested"
              value={money(loanCase.requestedAmount ?? undefined)}
              mono
            />
            <Fact label="Stage" value={CASE_STAGE_LABELS[loanCase.stage]} />
            <Fact label="Opened" value={exactly(loanCase.createdAt)} />
            <Fact label="Last changed" value={exactly(loanCase.updatedAt)} />
            {loanCase.closedAt && <Fact label="Closed" value={exactly(loanCase.closedAt)} />}
          </dl>
        </Card>

        <Card title="Where this data lives">
          <p className="text-xs text-ink-600">
            This case is a row in PostgreSQL, shared by every PC in the office. Two people looking
            at it see the same thing, and it survives a browser or a server restart.
          </p>
        </Card>
      </div>
    </div>
  );
}

function Fact({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs text-ink-500">{label}</dt>
      <dd className={cx("text-right text-sm", mono && "tnum")}>{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Parties and property — Phase 4 (case completeness). Backed by
// `case_party`/`case_property`, the same tables the requirement engine has
// read since migration 0021 — adding a co-applicant, guarantor or property
// here changes what the Documents tab asks for the next time it is read.
// ---------------------------------------------------------------------------

const PARTY_ROLE_LABELS: Record<CasePartyRole, string> = {
  applicant: "Applicant",
  co_applicant: "Co-applicant",
  guarantor: "Guarantor",
  referrer: "Referrer",
  borrower_firm: "Borrowing firm",
};

const ADDABLE_PARTY_ROLES: readonly CasePartyRole[] = [
  "co_applicant",
  "guarantor",
  "referrer",
  "borrower_firm",
];

function PartiesCard({ loanCase }: { loanCase: ApiCase }): ReactNode {
  const session = useSession();
  const query = useApiQuery<ApiCaseParty[]>(`/cases/${loanCase.id}/parties`);
  const [modal, setModal] = useState<"add" | null>(null);
  const mayEdit = session.canActOnCase(loanCase.ownerUserId, "case.update");

  const parties = (query.data ?? []).filter((p) => !p.removedAt);

  return (
    <Card
      title="Who is on this case"
      subtitle="The primary applicant, plus any co-applicant, guarantor, referrer or borrowing firm."
    >
      <div className="space-y-2">
        {query.loading && <Empty>Loading parties…</Empty>}
        {!query.loading && parties.length === 0 && <Empty>No applicant on this case.</Empty>}
        {parties.map((party) => (
          <PartyRow key={party.id} caseId={loanCase.id} party={party} mayEdit={mayEdit} onChanged={query.refetch} />
        ))}

        {!mayEdit && (
          <div>
            <p className="text-xs text-ink-500">You can see this case's parties but not change them.</p>
            <PermissionCode code="case.update" />
          </div>
        )}

        {mayEdit && (
          <div className="pt-1">
            <Button onClick={() => setModal("add")}>Add co-applicant / guarantor…</Button>
          </div>
        )}
      </div>

      {modal === "add" && (
        <AddPartyModal caseId={loanCase.id} onClose={() => setModal(null)} onChanged={query.refetch} />
      )}
    </Card>
  );
}

function PartyRow({
  caseId,
  party,
  mayEdit,
  onChanged,
}: {
  caseId: string;
  party: ApiCaseParty;
  mayEdit: boolean;
  onChanged: () => void;
}): ReactNode {
  const mutation = useMutation();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex items-center justify-between gap-3 border-b border-ink-100 py-2 last:border-0">
      <div>
        <p className="text-sm font-medium">
          {party.personId ? (
            <Link to={`/people/${party.personId}`} className="hover:underline">
              {party.name ?? "Unnamed"}
            </Link>
          ) : (
            (party.name ?? "Unnamed")
          )}
        </p>
        <p className="text-xs text-ink-500">{PARTY_ROLE_LABELS[party.role]}</p>
      </div>
      <div className="flex items-center gap-2">
        <Badge tone={party.isPrimary ? "info" : "good"}>{PARTY_ROLE_LABELS[party.role]}</Badge>
        {mayEdit && !party.isPrimary && (
          <Button
            variant="ghost"
            disabled={mutation.pending}
            onClick={() => setConfirming(true)}
          >
            Remove
          </Button>
        )}
      </div>

      {confirming && (
        <Modal open title={`Remove ${PARTY_ROLE_LABELS[party.role].toLowerCase()}`} onClose={() => setConfirming(false)}>
          <div className="space-y-3">
            <p className="text-sm text-ink-700">
              {party.name} stays on the case's history — this only removes them going forward. Their
              requirements become not applicable.
            </p>
            {mutation.error && (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
                {mutation.error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={mutation.pending}
                onClick={async () => {
                  const result = await mutation.run(() =>
                    api(`/cases/${caseId}/parties/${party.id}`, { method: "DELETE" }),
                  );
                  if (result) {
                    toast.show(`${party.name ?? "Party"} removed.`);
                    setConfirming(false);
                    onChanged();
                  }
                }}
              >
                Remove
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function AddPartyModal({
  caseId,
  onClose,
  onChanged,
}: {
  caseId: string;
  onClose: () => void;
  onChanged: () => void;
}): ReactNode {
  const mutation = useMutation();
  const toast = useToast();
  const [role, setRole] = useState<CasePartyRole>("co_applicant");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [chosen, setChosen] = useState<ApiCustomer | null>(null);

  const isFirm = role === "borrower_firm";
  const ready = isFirm ? name.trim().length > 1 : chosen !== null || name.trim().length > 1;

  return (
    <Modal open title="Add a party to this case" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Role">
          <Select value={role} onChange={(event) => setRole(event.target.value as CasePartyRole)}>
            {ADDABLE_PARTY_ROLES.map((value) => (
              <option key={value} value={value}>
                {PARTY_ROLE_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>

        {isFirm ? (
          <Field label="Organisation name" hint="Typing a name resolves or creates the organisation.">
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Firm name" />
          </Field>
        ) : (
          <CustomerSearchField
            name={name}
            phone={phone}
            chosen={chosen}
            onNameChange={setName}
            onPhoneChange={setPhone}
            onChoose={setChosen}
          />
        )}

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
            disabled={!ready || mutation.pending}
            onClick={async () => {
              const result = await mutation.run(() =>
                api(`/cases/${caseId}/parties`, {
                  method: "POST",
                  body: isFirm
                    ? { role, newOrganisationName: name.trim() }
                    : chosen
                      ? { role, personId: chosen.id }
                      : { role, newPersonName: name.trim(), newPersonPhone: phone.trim() },
                }),
              );
              if (result) {
                toast.show(`${PARTY_ROLE_LABELS[role]} added.`);
                onChanged();
                onClose();
              }
            }}
          >
            Add
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const CASE_PROPERTY_ROLE_LABELS: Record<CasePropertyRole, string> = {
  collateral: "Collateral",
  purchase: "Being purchased",
  both: "Purchase & collateral",
};

function PropertiesCard({ loanCase }: { loanCase: ApiCase }): ReactNode {
  const session = useSession();
  const query = useApiQuery<ApiCaseProperty[]>(`/cases/${loanCase.id}/properties`);
  const [modal, setModal] = useState<"add" | null>(null);
  const mayLink = session.canActOnCase(loanCase.ownerUserId, "case.update");
  const mayCreateProperty = session.can("property.create", "all");

  const properties = (query.data ?? []).filter((p) => !p.removedAt);

  return (
    <Card title="Property" subtitle="Secured collateral, or the property being purchased.">
      <div className="space-y-2">
        {query.loading && <Empty>Loading property…</Empty>}
        {!query.loading && properties.length === 0 && <Empty>No property recorded on this case.</Empty>}
        {properties.map((property) => (
          <PropertyRow key={property.id} caseId={loanCase.id} property={property} onChanged={query.refetch} />
        ))}

        {mayLink && (
          <div className="pt-1">
            <Button onClick={() => setModal("add")}>Add property…</Button>
          </div>
        )}
        {mayLink && !mayCreateProperty && (
          <div>
            <p className="text-xs text-ink-500">
              You may attach a property someone else already recorded, but not record a brand-new one.
            </p>
            <PermissionCode code="property.create" />
          </div>
        )}
        {!mayLink && (
          <div>
            <p className="text-xs text-ink-500">You can see this case's property but not change it.</p>
            <PermissionCode code="case.update" />
          </div>
        )}
      </div>

      {modal === "add" && (
        <AddPropertyModal caseId={loanCase.id} onClose={() => setModal(null)} onChanged={query.refetch} />
      )}
    </Card>
  );
}

function PropertyRow({
  caseId,
  property,
  onChanged,
}: {
  caseId: string;
  property: ApiCaseProperty;
  onChanged: () => void;
}): ReactNode {
  const mutation = useMutation();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);

  const label = [property.buildingName, property.locality, property.city].filter(Boolean).join(", ") || "Property";

  return (
    <div className="flex items-center justify-between gap-3 border-b border-ink-100 py-2 last:border-0">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {property.pincode && <p className="tnum text-xs text-ink-500">{property.pincode}</p>}
      </div>
      <div className="flex items-center gap-2">
        <Badge tone="info">{CASE_PROPERTY_ROLE_LABELS[property.role]}</Badge>
        <Button variant="ghost" disabled={mutation.pending} onClick={() => setConfirming(true)}>
          Remove
        </Button>
      </div>

      {confirming && (
        <Modal open title="Remove this property" onClose={() => setConfirming(false)}>
          <div className="space-y-3">
            <p className="text-sm text-ink-700">
              {label} stays on file — this only removes it from this case. Its requirements become not
              applicable.
            </p>
            {mutation.error && (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
                {mutation.error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={mutation.pending}
                onClick={async () => {
                  const result = await mutation.run(() =>
                    api(`/cases/${caseId}/properties/${property.id}`, { method: "DELETE" }),
                  );
                  if (result) {
                    toast.show(`${label} removed.`);
                    setConfirming(false);
                    onChanged();
                  }
                }}
              >
                Remove
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function AddPropertyModal({
  caseId,
  onClose,
  onChanged,
}: {
  caseId: string;
  onClose: () => void;
  onChanged: () => void;
}): ReactNode {
  const mutation = useMutation();
  const toast = useToast();
  const [role, setRole] = useState<CasePropertyRole>("collateral");
  const [locality, setLocality] = useState("");
  const [city, setCity] = useState("");

  const ready = locality.trim().length > 0;

  return (
    <Modal open title="Add a property to this case" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Role on this case">
          <Select value={role} onChange={(event) => setRole(event.target.value as CasePropertyRole)}>
            {(Object.keys(CASE_PROPERTY_ROLE_LABELS) as CasePropertyRole[]).map((value) => (
              <option key={value} value={value}>
                {CASE_PROPERTY_ROLE_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Locality" hint="Needed to be findable later — this is a new property record.">
          <Input value={locality} onChange={(event) => setLocality(event.target.value)} placeholder="Race Course" />
        </Field>
        <Field label="City" hint="Optional.">
          <Input value={city} onChange={(event) => setCity(event.target.value)} placeholder="Coimbatore" />
        </Field>

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
            disabled={!ready || mutation.pending}
            onClick={async () => {
              const result = await mutation.run(() =>
                api(`/cases/${caseId}/properties`, {
                  method: "POST",
                  body: { role, locality: locality.trim(), city: city.trim() || undefined },
                }),
              );
              if (result) {
                toast.show("Property added.");
                onChanged();
                onClose();
              }
            }}
          >
            Add
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Documents — Stage 3C. Real, PostgreSQL-backed requirements, uploads and
// verification, replacing what used to say "Not yet migrated" here.
// ---------------------------------------------------------------------------

const REQUIREMENT_STATUS_LABELS: Record<ApiRequirement["status"], string> = {
  pending: "Not received",
  received: "Awaiting verification",
  verified: "Verified",
  rejected: "Rejected",
  waived: "Waived",
  not_applicable: "Not applicable",
};

function statusTone(status: ApiRequirement["status"]): "info" | "warn" | "good" | "bad" {
  if (status === "verified") return "good";
  if (status === "rejected") return "bad";
  if (status === "received") return "info";
  return "warn";
}

function periodLabelFor(requirement: ApiRequirement): string | undefined {
  if (!requirement.periodStart) return undefined;
  return financialYearOf(new Date(requirement.periodStart)).label;
}

/**
 * Whose document this row is — "Applicant", "Co-applicant — Ravi Kumar",
 * "Property — Saibaba Colony".
 *
 * THE PROBLEM THIS SOLVES. A case with a co-applicant showed two rows called
 * "PAN Card", two called "Aadhaar Card" and two called "Bank Statement", with
 * nothing to tell them apart. They were never ambiguous underneath — the
 * requirement has pointed at the right `case_party` since the table was
 * created — but the screen printed only the document type, so the login desk
 * had to guess which upload belonged to whom, and a list that looks duplicated
 * is a list people stop trusting.
 *
 * Built from `requirement.subject`, which the API resolves from the
 * requirement's structural association. NOT from a string the server
 * concatenated, and emphatically not by this file inferring a subject from the
 * document type's name — the association is data, and rendering it is the only
 * part that belongs here.
 *
 * The name is included only when it adds something. On a single-applicant case
 * "Applicant" is unambiguous, and repeating the customer's name on all fourteen
 * rows is noise; with a co-applicant, the role alone already separates them.
 * The name earns its place on a property, where "Property" alone says nothing
 * about which one, and on a borrowing firm.
 */
function subjectLabel(requirement: ApiRequirement, showNames: boolean): string | null {
  const { kind, role, name } = requirement.subject;
  if (kind === "case") return null;

  if (kind === "property") {
    return name ? `Property — ${name}` : "Property";
  }

  const roleName = role
    ? (PARTY_ROLE_LABELS[role as CasePartyRole] ?? role.replace(/_/g, " "))
    : "Party";
  // A borrowing firm is always named: "Borrowing firm" is a role a case can
  // hold more than one of in principle, and the firm's name is what the
  // document is filed under.
  const alwaysName = role === "borrower_firm";
  return showNames || alwaysName ? (name ? `${roleName} — ${name}` : roleName) : roleName;
}

function DocumentsTab({
  loanCase,
  onCaseChanged,
}: {
  loanCase: ApiCase;
  onCaseChanged: () => void;
}): ReactNode {
  const query = useApiQuery<ApiCaseRequirements>(`/cases/${loanCase.id}/requirements`);
  const session = useSession();
  const [adding, setAdding] = useState(false);

  if (query.loading) return <Empty>Loading requirements…</Empty>;
  if (query.error || !query.data) {
    return (
      <Card title="Documents">
        <p className="text-sm text-ink-700">
          {query.error?.message ?? "Could not load this case's requirements."}
        </p>
        {query.error?.isRefusal && <PermissionCode code="document.read" />}
      </Card>
    );
  }

  const { requirements, progress } = query.data;
  const mayUpload = session.canActOnCase(loanCase.ownerUserId, "document.upload");
  const mayVerify = session.canActOnCase(loanCase.ownerUserId, "document.verify");
  const mayWaive = session.canActOnCase(loanCase.ownerUserId, "requirement.waive");
  // The permission that already governs inserting into `document_requirement`
  // (src/domain/permissions/tables.ts). Adding an ask is an ordinary act of
  // running the case; excusing one is `requirement.waive`, which is different.
  const mayAdd = session.canActOnCase(loanCase.ownerUserId, "case.update");

  const refetchAll = (): void => {
    query.refetch();
    // A verification or an upload can move the case's stage on its own
    // (ADR-019) — the header above the tabs must show that without a manual
    // page reload.
    onCaseChanged();
  };

  /**
   * Required and Additional are two different questions, so they are two
   * different sections.
   *
   * REQUIRED is what the rule engine says this case needs, given its facts. It
   * is the checklist, and it is not editable by hand — a row appears because a
   * rule fired, and disappears when the facts change.
   *
   * ADDITIONAL is what somebody asked for on this case alone
   * (`document_requirement.is_custom`): a lender's one-off ask, a letter
   * explaining a gap. Mixing the two would make the checklist look editable,
   * which is the misunderstanding that ends with people adding rows instead of
   * fixing the rule that is wrong.
   */
  const required = requirements.filter((requirement) => !requirement.isCustom);
  const additional = requirements.filter((requirement) => requirement.isCustom);

  // Only show a party's NAME beside their role where the case has more than
  // one person on it — see `subjectLabel`.
  const partySubjects = new Set(
    requirements
      .filter((requirement) => requirement.subject.kind === "party")
      .map((requirement) => requirement.requiredOfCasePartyId),
  );
  const showNames = partySubjects.size > 1;

  const byCategory = new Map<DocumentCategory, ApiRequirement[]>();
  for (const requirement of required) {
    const definition = DOCUMENT_CATALOGUE.find((type) => type.code === requirement.documentTypeCode);
    const category = definition?.category ?? "additional";
    const list = byCategory.get(category) ?? [];
    list.push(requirement);
    byCategory.set(category, list);
  }

  const nothingYet =
    loanCase.stage === "new" ||
    loanCase.stage === "contacted" ||
    loanCase.stage === "appointment_fixed";

  const row = (requirement: ApiRequirement): ReactNode => (
    <RequirementRow
      key={requirement.id}
      caseId={loanCase.id}
      requirement={requirement}
      showNames={showNames}
      mayUpload={mayUpload}
      mayVerify={mayVerify}
      mayWaive={mayWaive}
      onChanged={refetchAll}
    />
  );

  return (
    <div className="space-y-4">
      {requirements.length > 0 && (
        <Card title="Progress">
          <div className="space-y-2">
            <ProgressBar percent={progress.percentComplete} applicable={progress.applicableCount} />
            <p className="text-xs text-ink-500">
              {progress.verifiedCount} verified · {progress.outstandingCount} outstanding
              {progress.rejectedCount > 0 && ` (${progress.rejectedCount} rejected)`}
              {progress.optionalCount > 0 && ` · ${progress.optionalCount} optional`}
              {progress.upcomingCount > 0 && ` · ${progress.upcomingCount} not due yet`}
            </p>
            {progress.isReadyForSubmission && loanCase.stage === "documents_pending" && (
              <p className="text-xs text-ink-500">
                Everything required is verified — this case moves to Ready for Submission on its
                own.
              </p>
            )}
          </div>
        </Card>
      )}

      {required.length === 0 && (
        <Card title="Required documents">
          <Empty>
            {nothingYet
              ? "Nothing is due yet at this stage. Requirements appear once the case reaches Documents Pending."
              : "This case does not require any documents."}
          </Empty>
        </Card>
      )}

      {DOCUMENT_CATEGORIES.filter((category) => byCategory.has(category)).map((category) => (
        <Card key={category} title={DOCUMENT_CATEGORY_LABELS[category]} subtitle={DOCUMENT_CATEGORY_HINTS[category]}>
          <div className="divide-y divide-ink-100">{byCategory.get(category)!.map(row)}</div>
        </Card>
      ))}

      <Card
        title="Additional documents"
        subtitle="Asked for on this case only, by a person rather than by a rule."
      >
        <div className="space-y-3">
          {additional.length > 0 ? (
            <div className="divide-y divide-ink-100">{additional.map(row)}</div>
          ) : (
            <Empty>Nothing extra has been asked for on this case.</Empty>
          )}

          {mayAdd ? (
            <div className="pt-1">
              <Button onClick={() => setAdding(true)}>+ Add document</Button>
              <p className="mt-2 text-xs text-ink-500">
                For something the standard list does not cover — a lender's one-off ask, a letter
                explaining a gap. It adds a row; it cannot remove one the rules asked for. If the
                required list is wrong, the rule is what needs fixing.
              </p>
            </div>
          ) : (
            <div>
              <p className="text-xs text-ink-500">
                You can see this case's documents but not add to its list.
              </p>
              <PermissionCode code="case.update" />
            </div>
          )}
        </div>
      </Card>

      {adding && (
        <AddDocumentModal
          caseId={loanCase.id}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            refetchAll();
          }}
        />
      )}
    </div>
  );
}

/**
 * Ask this case for one more document.
 *
 * THE DOCUMENT TYPE COMES FROM THE CATALOGUE, never from a text box. A
 * free-text name would make the row unverifiable in any consistent way,
 * unfileable under a storage path, and — worst — would make "how often do we
 * end up asking for X?" unanswerable, which is exactly the question that tells
 * the business a rule is missing from the engine.
 */
function AddDocumentModal({
  caseId,
  onClose,
  onAdded,
}: {
  caseId: string;
  onClose: () => void;
  onAdded: () => void;
}): ReactNode {
  const mutation = useMutation();
  const toast = useToast();
  const parties = useApiQuery<ApiCaseParty[]>(`/cases/${caseId}/parties`);
  const properties = useApiQuery<ApiCaseProperty[]>(`/cases/${caseId}/properties`);

  const [documentTypeCode, setDocumentTypeCode] = useState("");
  const [subject, setSubject] = useState("case");
  const [note, setNote] = useState("");

  const livingParties = (parties.data ?? []).filter((party) => !party.removedAt);
  const livingProperties = (properties.data ?? []).filter((property) => !property.removedAt);

  return (
    <Modal open title="Add a document to this case" onClose={onClose}>
      <div className="space-y-3">
        <Field
          label="Document type"
          hint="From the standard catalogue, so this row uploads, verifies and files exactly like any other."
        >
          <Select value={documentTypeCode} onChange={(event) => setDocumentTypeCode(event.target.value)}>
            <option value="">Choose a document…</option>
            {DOCUMENT_CATEGORIES.map((category) => (
              <optgroup key={category} label={DOCUMENT_CATEGORY_LABELS[category]}>
                {DOCUMENT_CATALOGUE.filter((type) => type.category === category).map((type) => (
                  <option key={type.code} value={type.code}>
                    {type.name}
                    {type.localName ? ` (${type.localName})` : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>

        <Field
          label="Who it belongs to"
          hint="A document belongs to a person or a property, never to both (ADR-007). Leave it on the case where neither is right."
        >
          <Select value={subject} onChange={(event) => setSubject(event.target.value)}>
            <option value="case">This case</option>
            {livingParties.map((party) => (
              <option key={party.id} value={`party:${party.id}`}>
                {PARTY_ROLE_LABELS[party.role]}
                {party.name ? ` — ${party.name}` : ""}
              </option>
            ))}
            {livingProperties.map((property) => (
              <option key={property.id} value={`property:${property.id}`}>
                Property — {property.buildingName ?? property.locality ?? property.city ?? "Unnamed"}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Why (optional)" hint="One line. Whoever collects this will read it.">
          <Input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="HDFC asked for this specifically"
          />
        </Field>

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
            disabled={documentTypeCode === "" || mutation.pending}
            onClick={async () => {
              const [kind, id] = subject.split(":");
              const result = await mutation.run(() =>
                api<ApiRequirement>(`/cases/${caseId}/requirements`, {
                  method: "POST",
                  body: {
                    documentTypeCode,
                    ...(kind === "party" ? { casePartyId: id } : {}),
                    ...(kind === "property" ? { casePropertyId: id } : {}),
                    ...(note.trim() ? { note: note.trim() } : {}),
                  },
                }),
              );
              if (result) {
                toast.show("Added to this case's documents.");
                onAdded();
              }
            }}
          >
            {mutation.pending ? "Adding…" : "Add document"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function RequirementRow({
  caseId,
  requirement,
  showNames,
  mayUpload,
  mayVerify,
  mayWaive,
  onChanged,
}: {
  caseId: string;
  requirement: ApiRequirement;
  showNames: boolean;
  mayUpload: boolean;
  mayVerify: boolean;
  mayWaive: boolean;
  onChanged: () => void;
}): ReactNode {
  const definition = DOCUMENT_CATALOGUE.find((type) => type.code === requirement.documentTypeCode);
  const fileInput = useRef<HTMLInputElement>(null);
  const upload = useMutation();
  const decision = useMutation();
  const waive = useMutation();
  const toast = useToast();
  // One at a time. Nesting a reject form inside the verify dialog would put two
  // `role="dialog"` overlays on screen at once, each claiming the same heading
  // id — so choosing "No" closes the verify dialog and opens the reject one.
  const [dialog, setDialog] = useState<"view" | "verify" | "reject" | "waive" | null>(null);

  const label = documentRowLabel(
    definition?.name ?? requirement.documentTypeCode,
    periodLabelFor(requirement),
    definition?.periodKind,
  );

  /** The document type's own name, without the financial-year suffix — what a
   * dialog is titled with, so "PAN Card" and "Verify: PAN Card" name the same
   * thing the row does. */
  const typeName = definition?.name ?? requirement.documentTypeCode;

  const subjectLine = subjectLabel(requirement, showNames);

  /** The rule's name, and its note where the note says something the name does
   * not. Both are prose a business user wrote in the Document Rules screen. */
  const explanation = requirement.isCustom
    ? (requirement.customName ? "added for this case" : null)
    : requirement.generatedByRuleName;

  const canReupload = requirement.status === "pending" || requirement.status === "rejected";

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        {/* WHOSE document, above the document's own name. On a case with a
            co-applicant this is the difference between two identical-looking
            "PAN Card" rows and two rows a person can act on. */}
        {subjectLine && (
          <p className="text-xs font-medium uppercase tracking-wide text-ink-400">{subjectLine}</p>
        )}
        <p className="text-sm font-medium text-ink-900">
          {label}
          {requirement.applicability === "optional" && (
            <span className="ml-2 text-xs font-normal text-ink-400">Optional</span>
          )}
          {requirement.isCustom && (
            <span className="ml-2 text-xs font-normal text-ink-400">Added for this case</span>
          )}
        </p>
        {definition?.description && (
          <p className="mt-0.5 text-xs text-ink-500">{definition.description}</p>
        )}
        {/* WHY it is being asked for (Part 14 of the intake milestone). The
            rule's own name and note, which are written in a telecaller's
            words — never the rule code, the condition list or anything else
            an employee would have to be a developer to read. A hand-added row
            has no rule and says so instead. */}
        {explanation && <p className="mt-0.5 text-xs text-ink-400">Asked for: {explanation}</p>}
        {requirement.status === "rejected" && requirement.reason && (
          <p className="mt-1 rounded-md bg-red-50 px-2 py-1 text-xs text-red-900">
            {requirement.reason}
          </p>
        )}
        {requirement.status === "waived" && (
          <p className="mt-1 rounded-md bg-ink-50 px-2 py-1 text-xs text-ink-700">
            Waived{requirement.waivedAt ? ` ${when(requirement.waivedAt)}` : ""}
            {requirement.reason ? ` — ${requirement.reason}` : ""}
          </p>
        )}
        {requirement.document && (
          <p className="mt-1 text-xs text-ink-500">
            {requirement.document.fileName ?? "File"}
            {requirement.document.fileSizeBytes !== null && ` · ${bytes(requirement.document.fileSizeBytes)}`}
            {" · uploaded "}
            {when(requirement.document.uploadedAt)}
            {requirement.document.verifiedAt && ` · verified ${when(requirement.document.verifiedAt)}`}
          </p>
        )}
        {(upload.error || decision.error) && (
          <p className="mt-1 text-xs text-red-700" role="alert">
            {upload.error ?? decision.error}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Badge tone={statusTone(requirement.status)}>{REQUIREMENT_STATUS_LABELS[requirement.status]}</Badge>

        {requirement.document && (
          // "View" shows the document. It used to fetch the bytes and then
          // force a save through a synthetic `<a download>`, which overrode the
          // `Content-Disposition: inline` the server already sends — the login
          // desk could not read a PAN card without first cluttering Downloads.
          <Button variant="ghost" onClick={() => setDialog("view")}>
            View
          </Button>
        )}

        {mayUpload && canReupload && (
          <>
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                const result = await upload.run(() =>
                  apiUpload<ApiRequirement>(
                    `/cases/${caseId}/requirements/${requirement.id}/documents`,
                    file,
                  ),
                );
                if (result) {
                  toast.show(`${label} uploaded.`);
                  onChanged();
                }
              }}
            />
            <Button
              disabled={upload.pending}
              onClick={() => fileInput.current?.click()}
            >
              {requirement.status === "rejected" ? "Reupload" : "Upload"}
            </Button>
          </>
        )}

        {mayVerify && requirement.status === "received" && (
          <>
            {/* Verification is a person's judgement about a document, so it
                cannot be a single click on a row: this button OPENS the
                document. The decision is only sent from inside that dialog,
                after the document has actually been on screen. */}
            <Button variant="primary" disabled={decision.pending} onClick={() => setDialog("verify")}>
              Verify
            </Button>
            <Button variant="ghost" disabled={decision.pending} onClick={() => setDialog("reject")}>
              Reject
            </Button>
          </>
        )}

        {mayWaive && (requirement.status === "pending" || requirement.status === "received" || requirement.status === "rejected") && (
          <Button variant="ghost" disabled={waive.pending} onClick={() => setDialog("waive")}>
            Waive
          </Button>
        )}
      </div>

      {dialog === "view" && requirement.document && (
        <ViewDocumentDialog
          title={typeName}
          documentId={requirement.document.id}
          fileName={requirement.document.fileName}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === "verify" && requirement.document && (
        <VerifyDocumentDialog
          title={`Verify: ${typeName}`}
          documentId={requirement.document.id}
          fileName={requirement.document.fileName}
          pending={decision.pending}
          error={decision.error}
          onClose={() => setDialog(null)}
          onReject={() => setDialog("reject")}
          onConfirm={async () => {
            const result = await decision.run(() =>
              api<ApiRequirement>(`/cases/${caseId}/requirements/${requirement.id}/decision`, {
                method: "PUT",
                body: { decision: "verified" },
              }),
            );
            if (result) {
              toast.show(`${label} verified.`);
              setDialog(null);
              onChanged();
            }
          }}
        />
      )}

      {dialog === "reject" && (
        <RejectModal
          label={label}
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            const result = await decision.run(() =>
              api<ApiRequirement>(`/cases/${caseId}/requirements/${requirement.id}/decision`, {
                method: "PUT",
                body: { decision: "rejected", reason },
              }),
            );
            if (result) {
              toast.show(`${label} rejected.`);
              setDialog(null);
              onChanged();
            }
          }}
          pending={decision.pending}
          error={decision.error}
        />
      )}

      {dialog === "waive" && (
        <WaiveModal
          label={label}
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            const result = await waive.run(() =>
              api<ApiRequirement>(`/cases/${caseId}/requirements/${requirement.id}/waive`, {
                method: "PUT",
                body: { reason },
              }),
            );
            if (result) {
              toast.show(`${label} waived.`);
              setDialog(null);
              onChanged();
            }
          }}
          pending={waive.pending}
          error={waive.error}
        />
      )}
    </div>
  );
}

/**
 * A waiver excuses a requirement without pretending it was satisfied
 * (BR-035) — the server refuses one with no reason, and this dialog does not
 * offer a way around that.
 */
function WaiveModal({
  label,
  onClose,
  onSubmit,
  pending,
  error,
}: {
  label: string;
  onClose: () => void;
  onSubmit: (reason: string) => void;
  pending: boolean;
  error: string | null;
}): ReactNode {
  const [reason, setReason] = useState("");

  return (
    <Modal open title={`Waive ${label}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-ink-700">
          This sends the file forward with this requirement excused rather than satisfied. It stays on
          the case's record as waived, not deleted.
        </p>
        <Field label="Reason" hint="A waiver needs a name on it — who decided, and why.">
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            placeholder="Bank agreed to proceed without this document"
          />
        </Field>
        {error && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={pending || reason.trim().length === 0}
            onClick={() => onSubmit(reason.trim())}
          >
            Confirm waiver
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Seeing the document
// ---------------------------------------------------------------------------

/**
 * A document's bytes, on screen.
 *
 * The bytes are fetched with the session's bearer token (the storage route is
 * not public, and an `<img src>` cannot carry an Authorization header), turned
 * into an object URL, and handed to whichever element can render that type.
 * The URL is revoked when the dialog closes — an object URL that outlives its
 * dialog keeps the whole file alive in memory for as long as the tab is open,
 * and a login executive works through dozens of these in a morning.
 */
function DocumentPreview({
  documentId,
  fileName,
}: {
  documentId: string;
  fileName: string | null;
}): ReactNode {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; url: string; mimeType: string; name: string }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    setState({ status: "loading" });
    apiDownload(`/documents/${documentId}/download`)
      .then(({ blob, fileName: served }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({
          status: "ready",
          url: objectUrl,
          mimeType: blob.type,
          name: fileName ?? served,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState({
          status: "error",
          message: "This document could not be loaded. It may have been removed from storage.",
        });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [documentId, fileName]);

  if (state.status === "loading") {
    return (
      <div className="flex h-64 items-center justify-center rounded-md bg-ink-50 text-sm text-ink-500">
        Loading document…
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
        {state.message}
      </p>
    );
  }

  const mode = documentPreviewMode(state.mimeType, state.name);

  return (
    <div className="space-y-2">
      {mode === "image" && (
        <img
          src={state.url}
          alt={state.name}
          className="max-h-[60vh] w-full rounded-md bg-ink-50 object-contain"
        />
      )}

      {mode === "pdf" && (
        // The browser's own PDF viewer. No PDF.js: shipping a renderer to read
        // a PAN card is a large dependency to solve a problem Chrome and Edge
        // already solve, and the office runs both.
        <iframe
          src={state.url}
          title={state.name}
          className="h-[60vh] w-full rounded-md border border-ink-200 bg-ink-50"
        />
      )}

      {mode === "download_only" && (
        <div className="space-y-2 rounded-md bg-ink-50 px-3 py-4">
          <p className="text-sm text-ink-700">{previewFallbackMessage(state.name)}</p>
          {/* A real link, not a scripted click: this is the one place a save is
              what was actually asked for. */}
          <a
            href={state.url}
            download={state.name}
            className="inline-block text-sm text-brand-600 hover:underline"
          >
            Download {state.name}
          </a>
        </div>
      )}

      <p className="tnum text-xs text-ink-500">{state.name}</p>
    </div>
  );
}

/** Read-only. Opening a document is not a decision about it, so this dialog
 * has no verdict buttons — only a way out. */
function ViewDocumentDialog({
  title,
  documentId,
  fileName,
  onClose,
}: {
  title: string;
  documentId: string;
  fileName: string | null;
  onClose: () => void;
}): ReactNode {
  return (
    <Modal open title={title} onClose={onClose} size="wide">
      <div className="space-y-3">
        <DocumentPreview documentId={documentId} fileName={fileName} />
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The same viewer, with the verdict attached.
 *
 * WHY THE DOCUMENT IS IN THE DIALOG: "verified" is a claim that a person read
 * this file and it says what it should. When Verify was a bare button on the
 * row, the fastest way to clear a case was to click down the list without
 * opening anything, and the record would say a human checked it. Putting the
 * document in front of the verdict makes the honest path the easy one.
 *
 * "Not now" is offered as well as the two verdicts, because closing without
 * deciding must not look like a refusal to decide.
 */
function VerifyDocumentDialog({
  title,
  documentId,
  fileName,
  pending,
  error,
  onConfirm,
  onReject,
  onClose,
}: {
  title: string;
  documentId: string;
  fileName: string | null;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onReject: () => void;
  onClose: () => void;
}): ReactNode {
  return (
    <Modal open title={title} onClose={onClose} size="wide">
      <div className="space-y-3">
        <DocumentPreview documentId={documentId} fileName={fileName} />

        <p className="text-sm text-ink-700">
          Is this the right document, and is it readable? Verifying it is a record that you have
          read it.
        </p>

        {error && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
            {error}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <Button variant="ghost" disabled={pending} onClick={onReject}>
            No — wrong or unreadable
          </Button>
          <Button variant="primary" disabled={pending} onClick={onConfirm}>
            Yes — confirm &amp; verify
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function RejectModal({
  label,
  onClose,
  onSubmit,
  pending,
  error,
}: {
  label: string;
  onClose: () => void;
  onSubmit: (reason: string) => void;
  pending: boolean;
  error: string | null;
}): ReactNode {
  const [reason, setReason] = useState("");

  return (
    <Modal open title={`Reject ${label}`} onClose={onClose}>
      <div className="space-y-3">
        {/* Named "Reason for rejection" rather than "Why": this dialog is
            reachable both from the row and from the verify dialog's "No", and a
            one-word label loses its question when it arrives that second way.
            The requirement is unchanged — no reason, no rejection. */}
        <Field
          label="Reason for rejection"
          hint="Shown to whoever collects this document next — be specific."
        >
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            placeholder="Photo is blurred — please reupload"
          />
        </Field>
        {error && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={pending || reason.trim().length === 0}
            onClick={() => onSubmit(reason.trim())}
          >
            Confirm rejection
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/**
 * Everything that happened on this case, in order — the last of the four
 * sections to move off the prototype store (Overview/Documents/Banks moved in
 * Stages 3B/3C/3D). Follows exactly the same fetch/loading/error/empty shape
 * as `DocumentsTab`/`BanksTab`: `useApiQuery` against the server, which is the
 * one source of truth.
 *
 * NO PermissionCode HERE, unlike Documents/Banks. `GET /cases/:id/events`
 * (Backend/events.ts's `listCaseEvents`) never returns 403 — an actor who may
 * not see this case gets the identical 404 a nonexistent case would, so there
 * is no permission code to disclose and nothing to show beyond the server's
 * own message.
 */
function TimelineTab({ loanCase }: { loanCase: ApiCase }): ReactNode {
  const query = useApiQuery<readonly ApiTimelineEntry[]>(`/cases/${loanCase.id}/events`);

  if (query.loading) return <Empty>Loading timeline…</Empty>;
  if (query.error || !query.data) {
    return (
      <Card title="Timeline">
        <p className="text-sm text-ink-700">
          {query.error?.message ?? "Could not load this case's timeline."}
        </p>
      </Card>
    );
  }

  const entries = query.data;

  return (
    <Card title="Timeline" subtitle="Everything that happened, in order.">
      {entries.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        <ol className="space-y-4">
          {entries.map((entry) => (
            <li key={entry.id} className="border-l-2 border-ink-100 py-0.5 pl-4">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm font-medium text-ink-900">{entry.label}</p>
                <span className="shrink-0 text-xs text-ink-500">{exactly(entry.occurredAt)}</span>
              </div>
              {entry.detail && <p className="text-sm text-ink-700">{entry.detail}</p>}
              <p className="mt-0.5 text-xs text-ink-500">
                {entry.actorKind === "system" ? "System" : (entry.actorName ?? "Unknown")}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
