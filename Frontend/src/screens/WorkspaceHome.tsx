/**
 * The landing screen, per workspace.
 *
 * Every screen answers one question (Principle #2). These are five different
 * screens rather than one dashboard with five panels, because a screen that
 * answers five questions answers none of them well.
 */

import { Link } from "react-router-dom";
import type { ReactNode } from "react";

import { CASE_STAGE_LABELS } from "@domain/case/stages.js";

import { useDatabase } from "../fake/useDatabase.js";
import { completeTask, progressFor } from "../fake/store.js";
import type { Database, LoanCase } from "../fake/types.js";
import {
  lakhs,
  ownerName,
  primaryApplicant,
  primaryPhone,
  productLabel,
  waitingOn,
  when,
} from "../lib.js";
import { WORKSPACE_QUESTIONS, useSession } from "../session.js";
import { Badge, Button, Card, Empty, ProgressBar, StageBadge } from "../ui/index.js";

export function WorkspaceHome(): ReactNode {
  const session = useSession();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {WORKSPACE_QUESTIONS[session.workspace]}
        </h1>
        <p className="mt-1 text-sm text-ink-500">
          {session.user.name} · viewing the {session.workspace.replace(/_/g, " ")} workspace
        </p>
      </div>

      {session.workspace === "calling" && <CallingWorkspace />}
      {session.workspace === "login_desk" && <LoginDeskWorkspace />}
      {session.workspace === "management" && <ManagementWorkspace />}
      {session.workspace === "finance" && <FinanceWorkspace />}
      {session.workspace === "admin" && <AdminWorkspace />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * Cases the session may see, at the scope its permission actually carries.
 *
 * `own` is not "cases I created" — it is cases I own or am a named participant
 * on (ADR-027). In the prototype ownership is the whole of it, since no user is
 * a case party.
 */
function visibleCases(db: Database, can: (p: string, s?: "own" | "team" | "all") => boolean, userId: string): LoanCase[] {
  if (can("case.read", "all")) return db.cases;
  if (can("case.read", "own")) return db.cases.filter((c) => c.ownerUserId === userId);
  return [];
}

function isActive(loanCase: LoanCase): boolean {
  return loanCase.stage !== "closed" && loanCase.stage !== "lost";
}

/**
 * A held case is excluded from "needs attention" until its follow-up date. That
 * is the entire operational point of holds: a stalled case stops generating
 * noise without being forgotten (ADR-021).
 */
function needsAttention(loanCase: LoanCase): boolean {
  if (!isActive(loanCase)) return false;
  if (loanCase.isOnHold) {
    return loanCase.holdUntil !== undefined && new Date(loanCase.holdUntil) <= new Date();
  }
  return true;
}

function CaseRow({ loanCase }: { loanCase: LoanCase }): ReactNode {
  const db = useDatabase();
  const applicant = primaryApplicant(db, loanCase.id);
  const progress = progressFor(loanCase.id);
  const nextActor = waitingOn(
    db,
    loanCase,
    progress,
    db.submissions.filter((s) => s.caseId === loanCase.id),
  );

  return (
    <Link
      to={`/cases/${loanCase.id}`}
      className="flex items-center gap-4 px-4 py-2.5 hover:bg-ink-50"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{applicant?.fullName ?? "No applicant"}</span>
          {loanCase.isOnHold && <Badge tone="warn">On hold</Badge>}
        </div>
        <span className="tnum block truncate text-xs text-ink-500">
          {loanCase.caseNumber} · {productLabel(db, loanCase)} · {lakhs(loanCase.requestedAmount)}
        </span>
        {nextActor && (
          <span className="block truncate text-xs font-medium text-sky-700">
            {nextActor.summary}
          </span>
        )}
      </div>
      <div className="hidden w-32 sm:block">
        <ProgressBar percent={progress.percentComplete} applicable={progress.applicableCount} />
      </div>
      <StageBadge stage={loanCase.stage} label={CASE_STAGE_LABELS[loanCase.stage]} />
    </Link>
  );
}

function CaseRows({ cases, empty }: { cases: LoanCase[]; empty: string }): ReactNode {
  if (cases.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ul className="-mx-4 -my-4 divide-y divide-ink-100">
      {cases.map((loanCase) => (
        <li key={loanCase.id}>
          <CaseRow loanCase={loanCase} />
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Calling — who do I call next?
// ---------------------------------------------------------------------------

function CallingWorkspace(): ReactNode {
  const db = useDatabase();
  const session = useSession();

  const mine = visibleCases(db, session.can, session.user.id).filter(needsAttention);

  // Early stages first: a lead nobody has called is the most perishable thing on
  // the list.
  const order = ["new", "contacted", "appointment_fixed", "documents_pending"];
  const callList = mine
    .filter((c) => order.includes(c.stage))
    .sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));

  const myTasks = db.tasks.filter((t) => t.assignedTo === session.user.id && !t.completedAt);

  // Login Desk gets a "waiting on your verification" list; a Telecaller's
  // equivalent is a document THEY collected that came back rejected — the
  // one case where the ball is back in their court, since only they can
  // re-contact the customer for it (audit finding 9.2). Deliberately narrow:
  // just the actionable rejected-document work, not a general notification feed.
  const mineIds = new Set(mine.map((c) => c.id));
  const needsFollowUp = db.requirements.filter(
    (r) => r.status === "rejected" && mineIds.has(r.caseId),
  );

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card
          title="Call list"
          subtitle="Earliest stages first — an uncalled lead is the most perishable thing here"
        >
          <CaseRows cases={callList} empty="Nothing waiting on a call. That is a good state." />
        </Card>

        <Card title="Everything else you own" subtitle="Past the calling stages">
          <CaseRows
            cases={mine.filter((c) => !order.includes(c.stage))}
            empty="No cases past documents yet."
          />
        </Card>
      </div>

      <div className="space-y-6">
        <Card
          title="Rejected — needs your follow-up"
          subtitle="Login Desk sent these back. Contact the customer for a replacement."
        >
          {needsFollowUp.length === 0 ? (
            <Empty>Nothing rejected. That is a good state.</Empty>
          ) : (
            <ul className="space-y-2">
              {needsFollowUp.map((requirement) => {
                const loanCase = db.cases.find((c) => c.id === requirement.caseId);
                const type = db.documentTypes.find((t) => t.id === requirement.documentTypeId);
                const document = db.documents.find(
                  (d) => d.id === requirement.satisfiedByDocumentId,
                );
                return (
                  <li key={requirement.id}>
                    <Link
                      to={`/cases/${requirement.caseId}?tab=documents`}
                      className="block rounded p-2 hover:bg-ink-50"
                    >
                      <span className="block text-sm font-medium">
                        {requirement.customName ?? type?.name ?? "Document"}
                      </span>
                      <span className="tnum block text-xs text-ink-500">
                        {loanCase?.caseNumber}
                      </span>
                      {document?.rejectionReason && (
                        <span className="block text-xs text-red-700">
                          {document.rejectionReason}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Your tasks">
          {myTasks.length === 0 ? (
            <Empty>Nothing due.</Empty>
          ) : (
            <ul className="space-y-2">
              {myTasks.map((task) => (
                <li key={task.id} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    onChange={() => completeTask(task.id, session.user.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{task.title}</span>
                    <span className="block text-xs text-ink-500">
                      {task.caseId ? (
                        <Link to={`/cases/${task.caseId}`} className="hover:underline">
                          {db.cases.find((c) => c.id === task.caseId)?.caseNumber}
                        </Link>
                      ) : (
                        "No case"
                      )}{" "}
                      · due {when(task.dueAt)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="On hold" subtitle="Out of the way until their follow-up date">
          <CaseRows
            cases={visibleCases(db, session.can, session.user.id).filter(
              (c) => c.isOnHold && isActive(c),
            )}
            empty="Nothing on hold."
          />
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Login desk — what is missing before this file goes to the bank?
// ---------------------------------------------------------------------------

function LoginDeskWorkspace(): ReactNode {
  const db = useDatabase();
  const session = useSession();

  const cases = visibleCases(db, session.can, session.user.id).filter(isActive);

  const collecting = cases
    .filter((c) => c.stage === "documents_pending")
    .map((c) => ({ loanCase: c, progress: progressFor(c.id) }))
    // Nearly-complete files first: those are the ones a push actually finishes.
    .sort((a, b) => b.progress.percentComplete - a.progress.percentComplete);

  const ready = cases.filter((c) => c.stage === "ready_for_submission");
  const atBank = cases.filter((c) => ["submitted", "sanctioned"].includes(c.stage));

  const toVerify = db.requirements.filter(
    (r) => r.status === "received" && cases.some((c) => c.id === r.caseId),
  );

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card
          title="Collecting"
          subtitle="Closest to complete first — those are the files a push actually finishes"
        >
          <CaseRows cases={collecting.map((c) => c.loanCase)} empty="Nothing in collection." />
        </Card>

        <Card title="Ready to go to a bank" subtitle="Complete and verified, awaiting bank selection">
          <CaseRows cases={ready} empty="Nothing ready. Finish a file above." />
        </Card>

        <Card title="At a bank" subtitle="Live submissions, waiting on someone else">
          <CaseRows cases={atBank} empty="Nothing at a bank." />
        </Card>
      </div>

      <div className="space-y-6">
        <Card title="Waiting on your verification" subtitle="Uploaded, not yet checked by a human">
          {toVerify.length === 0 ? (
            <Empty>Nothing to verify.</Empty>
          ) : (
            <ul className="space-y-2">
              {toVerify.map((requirement) => {
                const loanCase = db.cases.find((c) => c.id === requirement.caseId);
                const type = db.documentTypes.find((t) => t.id === requirement.documentTypeId);
                return (
                  <li key={requirement.id}>
                    <Link
                      to={`/cases/${requirement.caseId}`}
                      className="block rounded p-2 hover:bg-ink-50"
                    >
                      <span className="block text-sm font-medium">{type?.name}</span>
                      <span className="tnum block text-xs text-ink-500">
                        {loanCase?.caseNumber}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Management — which cases need attention today?
// ---------------------------------------------------------------------------

function ManagementWorkspace(): ReactNode {
  const db = useDatabase();
  const session = useSession();

  const cases = visibleCases(db, session.can, session.user.id);
  const active = cases.filter(isActive);
  const attention = active.filter(needsAttention);

  const expiring = db.offers.filter(
    (offer) =>
      !offer.isAccepted &&
      offer.validUntil !== undefined &&
      new Date(offer.validUntil) > new Date() &&
      new Date(offer.validUntil).getTime() - Date.now() < 14 * 86400000,
  );

  const rejections = db.submissions.filter((s) => s.status === "rejected");
  const byReason = new Map<string, number>();
  for (const submission of rejections) {
    const reason = db.rejectionReasons.find((r) => r.id === submission.rejectionReasonId);
    if (reason) byReason.set(reason.name, (byReason.get(reason.name) ?? 0) + 1);
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Active cases" value={String(active.length)} />
        <Stat label="Need attention" value={String(attention.length)} />
        <Stat
          label="On hold"
          value={String(active.filter((c) => c.isOnHold).length)}
          hint="Deliberately quiet"
        />
        <Stat label="Offers expiring" value={String(expiring.length)} hint="Within 14 days" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title="Needs attention"
          subtitle="Held cases are excluded until their follow-up date — that is what a hold is for"
        >
          <CaseRows cases={attention} empty="Nothing needs attention. Unlikely, but pleasant." />
        </Card>

        <div className="space-y-6">
          <Card
            title="Why banks said no"
            subtitle="The standardised category, not the bank's wording"
          >
            {byReason.size === 0 ? (
              <Empty>No rejections recorded.</Empty>
            ) : (
              <ul className="space-y-1.5">
                {[...byReason.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([name, count]) => (
                    <li key={name} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate text-ink-700">{name}</span>
                      <span className="tnum shrink-0 font-medium">{count}</span>
                    </li>
                  ))}
              </ul>
            )}
            <p className="mt-3 border-t border-ink-100 pt-3 text-xs text-ink-500">
              This is the point of a controlled list. Five banks describe one refusal five ways;
              only the category can be counted.
            </p>
          </Card>

          <Card title="Team" subtitle="Who is carrying what">
            <ul className="space-y-1.5">
              {db.users.map((user) => {
                const owned = active.filter((c) => c.ownerUserId === user.id).length;
                return (
                  <li key={user.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate text-ink-700">{user.name}</span>
                    <span className="tnum shrink-0 font-medium">{owned}</span>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Finance — what is owed, and what is collected?
// ---------------------------------------------------------------------------

function FinanceWorkspace(): ReactNode {
  const db = useDatabase();
  const session = useSession();

  const cases = visibleCases(db, session.can, session.user.id);

  // A case sitting in Disbursed is money owed to Amaze. Collapsing Disbursed and
  // Closed would hide exactly this (PRD/Loan Lifecycle.md).
  const awaitingCloseOut = cases.filter((c) => c.stage === "disbursed");
  const closed = cases.filter((c) => c.stage === "closed");

  const disbursedValue = db.submissions
    .filter((s) => s.status === "disbursed")
    .map((s) => db.offers.find((o) => o.submissionId === s.id)?.sanctionedAmount ?? 0)
    .reduce((total, value) => total + value, 0);

  const feesCollected = db.submissions
    .filter((s) => s.loginFeeAmount !== undefined)
    .reduce((total, s) => total + (s.loginFeeAmount ?? 0), 0);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Awaiting close-out" value={String(awaitingCloseOut.length)} hint="Invoice not yet raised" />
        <Stat label="Disbursed value" value={lakhs(disbursedValue)} />
        <Stat
          label="Login fees"
          value={session.can("commercial.view", "all") ? lakhs(feesCollected) : "••••"}
          hint={session.can("commercial.view", "all") ? "Collected" : "Needs commercial.view"}
        />
      </div>

      <Card
        title="Disbursed, not yet closed"
        subtitle="Money has moved and the company's work is not finished — this is the signal that would vanish if Disbursed and Closed were one stage"
      >
        <CaseRows cases={awaitingCloseOut} empty="Nothing awaiting close-out." />
      </Card>

      <Card title="Closed" subtitle="Invoice raised, commission settled">
        <CaseRows cases={closed} empty="Nothing closed yet." />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin — is the system healthy?
// ---------------------------------------------------------------------------

function AdminWorkspace(): ReactNode {
  const db = useDatabase();

  return (
    <div className="space-y-6">
      <Card
        title="Users and roles"
        subtitle="A user holds many roles and receives the union of their permissions"
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-100 text-left text-xs text-ink-500">
              <th className="pb-2 font-medium">User</th>
              <th className="pb-2 font-medium">Roles</th>
              <th className="pb-2 font-medium">Cases owned</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {db.users.map((user) => (
              <tr key={user.id}>
                <td className="py-2">{user.name}</td>
                <td className="py-2 text-ink-500">{user.roles.join(", ")}</td>
                <td className="tnum py-2">
                  {db.cases.filter((c) => c.ownerUserId === user.id).length}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card
        title="Recent activity"
        subtitle="The append-only event log — every timeline, audit and report reads from here"
      >
        <ul className="space-y-2">
          {[...db.events]
            .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
            .slice(0, 20)
            .map((event) => (
              <li key={event.id} className="flex items-start gap-3 text-sm">
                <Badge tone={event.actorKind === "system" ? "info" : "neutral"}>
                  {event.actorKind}
                </Badge>
                <span className="min-w-0 flex-1">
                  <span className="block">{event.summary}</span>
                  <span className="block text-xs text-ink-500">
                    {when(event.occurredAt)}
                    {event.causedBy && ` · ${event.causedBy}`}
                  </span>
                </span>
              </li>
            ))}
        </ul>
      </Card>

      <Card title="What Admin cannot see" subtitle="Administering the system is not a licence to read the customers">
        <p className="text-sm text-ink-700">
          This role holds no <code>document.read</code>, <code>communication.read</code> or{" "}
          <code>note.read</code>, and no <code>identifier.view_full</code> or{" "}
          <code>commercial.view</code>. Open a case from here and the documents, calls and notes are
          absent — not greyed out, absent.
        </p>
        <p className="mt-2 text-xs text-ink-500">
          Switch to Karthik V to see the same case as the login desk sees it.
        </p>
      </Card>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }): ReactNode {
  return (
    <div className="rounded-lg bg-white p-4 ring-1 ring-ink-100">
      <p className="text-xs font-medium text-ink-500">{label}</p>
      <p className="tnum mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-400">{hint}</p>}
    </div>
  );
}

export { ownerName };
