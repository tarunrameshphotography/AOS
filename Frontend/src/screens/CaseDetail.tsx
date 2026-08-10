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

import { useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import {
  CASE_STAGES,
  CASE_STAGE_LABELS,
  LOST_REASONS,
  LOST_REASON_LABELS,
  type CaseStage,
  type LostReason,
} from "@domain/case/stages.js";
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
import type { ApiCase, ApiCaseRequirements, ApiRequirement } from "../api/types.js";
import { bytes, exactly, lakhs, money, when } from "../lib.js";
import { useSession } from "../session.js";
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
  Textarea,
  cx,
  useToast,
} from "../ui/index.js";

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
            </button>
          ))}
          <span className="ml-3 text-xs text-ink-500">{CASE_TAB_PURPOSE[tab]}</span>
        </div>
      </div>

      {tab === "overview" && <Overview loanCase={loanCase} onChanged={query.refetch} />}
      {tab === "documents" && <DocumentsTab loanCase={loanCase} onCaseChanged={query.refetch} />}
      {(tab === "banks" || tab === "timeline") && <NotYetMigrated tab={tab} />}
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
          <h1 className="tnum text-xl font-semibold tracking-tight">{loanCase.caseNumber}</h1>
          <StageBadge stage={loanCase.stage} label={CASE_STAGE_LABELS[loanCase.stage]} />
          {loanCase.isOnHold && <Badge tone="warn">On hold</Badge>}
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
  const [stage, setStage] = useState<CaseStage>(loanCase.stage);

  return (
    <Modal open title="Move stage" onClose={onClose}>
      <div className="space-y-3">
        <Field
          label="Move to"
          hint="The server judges the move. Some stages are reached automatically by what happens on the case, not by choosing them here."
        >
          <Select value={stage} onChange={(event) => setStage(event.target.value as CaseStage)}>
            {CASE_STAGES.filter((value) => value !== "lost").map((value) => (
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

        <Card
          title="Who is on this case"
          subtitle="Co-applicants, guarantors and property are added when the requirement engine moves — see below."
        >
          {loanCase.applicantId ? (
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">
                  <Link to={`/people/${loanCase.applicantId}`} className="hover:underline">
                    {loanCase.applicantName}
                  </Link>
                </p>
                <p className="tnum text-xs text-ink-500">
                  {loanCase.applicantPhone ?? "No number on file"}
                </p>
              </div>
              <Badge tone="info">Applicant</Badge>
            </div>
          ) : (
            <Empty>No applicant on this case.</Empty>
          )}
        </Card>
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

function DocumentsTab({
  loanCase,
  onCaseChanged,
}: {
  loanCase: ApiCase;
  onCaseChanged: () => void;
}): ReactNode {
  const query = useApiQuery<ApiCaseRequirements>(`/cases/${loanCase.id}/requirements`);
  const session = useSession();

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

  const refetchAll = (): void => {
    query.refetch();
    // A verification or an upload can move the case's stage on its own
    // (ADR-019) — the header above the tabs must show that without a manual
    // page reload.
    onCaseChanged();
  };

  if (requirements.length === 0) {
    return (
      <Card title="Documents">
        <Empty>
          {loanCase.stage === "new" || loanCase.stage === "contacted" || loanCase.stage === "appointment_fixed"
            ? "Nothing is due yet at this stage. Requirements appear once the case reaches Documents Pending."
            : "This case does not require any documents."}
        </Empty>
      </Card>
    );
  }

  const byCategory = new Map<DocumentCategory, ApiRequirement[]>();
  for (const requirement of requirements) {
    const definition = DOCUMENT_CATALOGUE.find((type) => type.code === requirement.documentTypeCode);
    const category = definition?.category ?? "additional";
    const list = byCategory.get(category) ?? [];
    list.push(requirement);
    byCategory.set(category, list);
  }

  return (
    <div className="space-y-4">
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

      {DOCUMENT_CATEGORIES.filter((category) => byCategory.has(category)).map((category) => (
        <Card key={category} title={DOCUMENT_CATEGORY_LABELS[category]} subtitle={DOCUMENT_CATEGORY_HINTS[category]}>
          <div className="divide-y divide-ink-100">
            {byCategory.get(category)!.map((requirement) => (
              <RequirementRow
                key={requirement.id}
                caseId={loanCase.id}
                requirement={requirement}
                mayUpload={mayUpload}
                mayVerify={mayVerify}
                onChanged={refetchAll}
              />
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

function RequirementRow({
  caseId,
  requirement,
  mayUpload,
  mayVerify,
  onChanged,
}: {
  caseId: string;
  requirement: ApiRequirement;
  mayUpload: boolean;
  mayVerify: boolean;
  onChanged: () => void;
}): ReactNode {
  const definition = DOCUMENT_CATALOGUE.find((type) => type.code === requirement.documentTypeCode);
  const fileInput = useRef<HTMLInputElement>(null);
  const upload = useMutation();
  const decision = useMutation();
  const toast = useToast();
  const [rejectOpen, setRejectOpen] = useState(false);

  const label = documentRowLabel(
    definition?.name ?? requirement.documentTypeCode,
    periodLabelFor(requirement),
    definition?.periodKind,
  );

  const canReupload = requirement.status === "pending" || requirement.status === "rejected";

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink-900">
          {label}
          {requirement.applicability === "optional" && (
            <span className="ml-2 text-xs font-normal text-ink-400">Optional</span>
          )}
        </p>
        {definition?.description && (
          <p className="mt-0.5 text-xs text-ink-500">{definition.description}</p>
        )}
        {requirement.status === "rejected" && requirement.reason && (
          <p className="mt-1 rounded-md bg-red-50 px-2 py-1 text-xs text-red-900">
            {requirement.reason}
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
          <Button
            variant="ghost"
            onClick={async () => {
              try {
                const { blob, fileName } = await apiDownload(
                  `/documents/${requirement.document!.id}/download`,
                );
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = fileName;
                anchor.click();
                URL.revokeObjectURL(url);
              } catch {
                toast.show("Could not download this document.");
              }
            }}
          >
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
            <Button
              variant="primary"
              disabled={decision.pending}
              onClick={async () => {
                const result = await decision.run(() =>
                  api<ApiRequirement>(`/cases/${caseId}/requirements/${requirement.id}/decision`, {
                    method: "PUT",
                    body: { decision: "verified" },
                  }),
                );
                if (result) {
                  toast.show(`${label} verified.`);
                  onChanged();
                }
              }}
            >
              Verify
            </Button>
            <Button variant="ghost" disabled={decision.pending} onClick={() => setRejectOpen(true)}>
              Reject
            </Button>
          </>
        )}
      </div>

      {rejectOpen && (
        <RejectModal
          label={label}
          onClose={() => setRejectOpen(false)}
          onSubmit={async (reason) => {
            const result = await decision.run(() =>
              api<ApiRequirement>(`/cases/${caseId}/requirements/${requirement.id}/decision`, {
                method: "PUT",
                body: { decision: "rejected", reason },
              }),
            );
            if (result) {
              toast.show(`${label} rejected.`);
              setRejectOpen(false);
              onChanged();
            }
          }}
          pending={decision.pending}
          error={decision.error}
        />
      )}
    </div>
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
        <Field label="Why" hint="Shown to whoever collects this document next — be specific.">
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
            Reject
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The tabs that have not moved yet
// ---------------------------------------------------------------------------

/** What each un-migrated tab is waiting for, in the words of the thing it
 * needs. Vague placeholders ("coming soon") teach nobody anything; naming the
 * dependency tells a reader when to expect it back. Documents moved in
 * Stage 3C — see `DocumentsTab` below — and left this list. */
const WAITING_ON: Record<"banks" | "timeline", { what: string; why: string }> = {
  banks: {
    what: "Bank submissions and offers",
    why: "Submissions depend on verified documents, which now exist (Stage 3C) — this is the next slice, not a re-statement of the same gap.",
  },
  timeline: {
    what: "The case timeline",
    why: "The event log records what every other slice does. It is written for administrative actions, case, customer and document events already; the reading screen is what has not moved.",
  },
};

function NotYetMigrated({ tab }: { tab: "banks" | "timeline" }): ReactNode {
  const waiting = WAITING_ON[tab];

  return (
    <Card title={CASE_TAB_LABELS[tab]}>
      <div className="max-w-prose space-y-3">
        <p className="text-sm font-medium text-ink-900">Not yet migrated.</p>
        <p className="text-sm text-ink-700">
          This case lives in PostgreSQL. {waiting.what} has not moved to the server yet, so there
          is nothing here — rather than something that would not survive a refresh, and would not
          be visible to anyone else in the office.
        </p>
        <p className="text-xs text-ink-500">{waiting.why}</p>
      </div>
    </Card>
  );
}
