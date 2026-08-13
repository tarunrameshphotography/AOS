/**
 * The landing screen, per workspace.
 *
 * Every screen answers one question (Principle #2). These are five different
 * screens rather than one dashboard with five panels, because a screen that
 * answers five questions answers none of them well.
 *
 * STAGE 3B: the case queues come from `GET /api/cases`, so what a Telecaller
 * sees on their own home screen is scoped by the server rather than filtered
 * in the browser. The panels that counted documents, requirements, tasks,
 * offers and submissions are marked not-yet-migrated instead of being computed
 * from the prototype store — a "3 awaiting verification" tile derived from
 * data that no longer describes these cases is worse than an empty one,
 * because a number looks authoritative in a way an empty state does not.
 */

import { Link } from "react-router-dom";
import { useMemo, type ReactNode } from "react";

import { CASE_STAGE_LABELS } from "@domain/case/stages.js";

import { useReference, useUsers } from "../api/catalogue.js";
import { useApiQuery } from "../api/hooks.js";
import type { ApiCase } from "../api/types.js";
import { lakhs, when } from "../lib.js";
import { WORKSPACE_QUESTIONS, useSession } from "../session.js";
import { Badge, Card, Empty, StageBadge } from "../ui/index.js";

export function WorkspaceHome(): ReactNode {
  const session = useSession();
  const cases = useApiQuery<readonly ApiCase[]>("/cases");

  const all = cases.data ?? [];
  const active = useMemo(
    () => all.filter((c) => c.stage !== "closed" && c.stage !== "lost"),
    [all],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink-900">
          {WORKSPACE_QUESTIONS[session.workspace]}
        </h1>
        <p className="mt-1 text-sm text-ink-500">
          {session.displayName} · viewing the {session.workspace.replace(/_/g, " ")} workspace
        </p>
      </div>

      {cases.loading ? (
        <Empty>Loading your work…</Empty>
      ) : cases.error ? (
        <Empty>{cases.error.message}</Empty>
      ) : session.workspace === "calling" ? (
        <CallingWorkspace active={active} />
      ) : session.workspace === "login_desk" ? (
        <LoginDeskWorkspace active={active} />
      ) : session.workspace === "management" ? (
        <ManagementWorkspace all={all} active={active} />
      ) : session.workspace === "finance" ? (
        <FinanceWorkspace all={all} />
      ) : (
        <AdminWorkspace all={all} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** A case nobody has moved recently, or one deliberately parked. `isOnHold` is
 * excluded rather than flagged: a hold is a decision, not a lapse. */
function needsAttention(loanCase: ApiCase): boolean {
  if (loanCase.isOnHold) return false;
  const idleDays = (Date.now() - new Date(loanCase.updatedAt).getTime()) / 86400000;
  return idleDays >= 3;
}

function CaseRow({ loanCase }: { loanCase: ApiCase }): ReactNode {
  const reference = useReference();
  const users = useUsers();

  return (
    <li className="py-2.5 first:pt-0 last:pb-0">
      <Link to={`/cases/${loanCase.id}`} className="flex flex-wrap items-center gap-2">
        <span className="tnum text-sm font-medium hover:underline">{loanCase.caseNumber}</span>
        <span className="text-sm text-ink-700">{loanCase.applicantName ?? "No applicant"}</span>
        {loanCase.applicantPhone && (
          <span className="tnum text-xs text-ink-500">{loanCase.applicantPhone}</span>
        )}
        {loanCase.isOnHold && <Badge tone="warn">Hold</Badge>}
        <span className="ml-auto flex items-center gap-2">
          <span className="tnum text-xs text-ink-500">
            {lakhs(loanCase.requestedAmount ?? undefined)}
          </span>
          <StageBadge stage={loanCase.stage} label={CASE_STAGE_LABELS[loanCase.stage]} />
        </span>
      </Link>
      <p className="mt-0.5 text-xs text-ink-500">
        {reference.productLabel(loanCase.loanProductId)} ·{" "}
        {users.ownerName(loanCase.ownerUserId)} · last touched {when(loanCase.updatedAt)}
      </p>
    </li>
  );
}

function CaseRows({ cases, empty }: { cases: readonly ApiCase[]; empty: string }): ReactNode {
  if (cases.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ul className="divide-y divide-ink-100">
      {cases.map((loanCase) => (
        <CaseRow key={loanCase.id} loanCase={loanCase} />
      ))}
    </ul>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }): ReactNode {
  return (
    <div className="rounded-lg bg-white p-4 ring-1 ring-ink-150">
      <p className="text-xs font-medium text-ink-500">{label}</p>
      <p className="font-display tnum mt-1.5 text-3xl font-semibold tracking-tight text-ink-900">
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
    </div>
  );
}

/** One consistent way of saying "this panel is waiting on a later stage", so
 * an empty queue and an unmigrated queue never look alike. */
function Pending({ title, what }: { title: string; what: string }): ReactNode {
  return (
    <Card title={title}>
      <p className="text-sm font-medium text-ink-900">Not yet migrated.</p>
      <p className="mt-1 text-sm text-ink-700">{what}</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function CallingWorkspace({ active }: { active: readonly ApiCase[] }): ReactNode {
  // Early stages first: a lead nobody has called is the most perishable thing
  // on the list.
  const order = ["new", "contacted", "appointment_fixed", "documents_pending"];
  const callList = active
    .filter((c) => order.includes(c.stage))
    .sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));

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
            cases={active.filter((c) => !order.includes(c.stage))}
            empty="No cases past documents yet."
          />
        </Card>
      </div>

      <div className="space-y-6">
        <Card title="Needs attention" subtitle="Untouched for three days or more">
          <CaseRows
            cases={active.filter(needsAttention)}
            empty="Everything has been touched recently."
          />
        </Card>
        <Pending
          title="Rejected — needs your follow-up"
          what="Document rejections come back here once documents and the requirement engine move to the server."
        />
      </div>
    </div>
  );
}

function LoginDeskWorkspace({ active }: { active: readonly ApiCase[] }): ReactNode {
  const collecting = active.filter((c) => c.stage === "documents_pending");
  const ready = active.filter((c) => c.stage === "ready_for_submission");
  const atBank = active.filter((c) => ["submitted", "sanctioned"].includes(c.stage));

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card title="Collecting" subtitle="Files still gathering documents">
          <CaseRows cases={collecting} empty="Nothing in collection." />
        </Card>
        <Card title="Ready to go to a bank">
          <CaseRows cases={ready} empty="Nothing ready." />
        </Card>
        <Card title="With a bank" subtitle="Submitted or sanctioned">
          <CaseRows cases={atBank} empty="Nothing with a bank." />
        </Card>
      </div>

      <div className="space-y-6">
        <Pending
          title="Awaiting your verification"
          what="The verification queue is built from document requirements, which move to the server in a later stage."
        />
      </div>
    </div>
  );
}

function ManagementWorkspace({
  all,
  active,
}: {
  all: readonly ApiCase[];
  active: readonly ApiCase[];
}): ReactNode {
  const attention = active.filter(needsAttention);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Active cases" value={String(active.length)} />
        <Stat label="Need attention" value={String(attention.length)} hint="Untouched 3+ days" />
        <Stat
          label="On hold"
          value={String(active.filter((c) => c.isOnHold).length)}
          hint="Deliberately quiet"
        />
        <Stat
          label="Lost"
          value={String(all.filter((c) => c.stage === "lost").length)}
          hint="All time"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Needs attention" subtitle="Nobody has touched these in three days">
          <CaseRows cases={attention} empty="Everything is moving." />
        </Card>
        <Card title="On hold" subtitle="Parked deliberately — with a reason on each">
          <CaseRows cases={active.filter((c) => c.isOnHold)} empty="Nothing on hold." />
        </Card>
      </div>

      <Pending
        title="Offers expiring, and why banks reject"
        what="Both are built from submissions and offers, which have not moved to the server yet."
      />
    </div>
  );
}

function FinanceWorkspace({ all }: { all: readonly ApiCase[] }): ReactNode {
  // A case sitting in Disbursed is money owed to Amaze. Collapsing Disbursed
  // and Closed would hide exactly this (PRD/Loan Lifecycle.md).
  const awaitingCloseOut = all.filter((c) => c.stage === "disbursed");
  const closed = all.filter((c) => c.stage === "closed");

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Awaiting close-out"
          value={String(awaitingCloseOut.length)}
          hint="Invoice not yet raised"
        />
        <Stat label="Closed" value={String(closed.length)} />
        <Stat
          label="Requested value, active"
          value={lakhs(
            all
              .filter((c) => c.stage !== "closed" && c.stage !== "lost")
              .reduce((total, c) => total + (c.requestedAmount ?? 0), 0),
          )}
          hint="What customers asked for"
        />
      </div>

      <Card title="Awaiting close-out">
        <CaseRows cases={awaitingCloseOut} empty="Nothing awaiting close-out." />
      </Card>

      <Pending
        title="Disbursed value and login fees"
        what="Both come from offers and submissions, which have not moved to the server yet. Only what customers requested can be totalled today."
      />
    </div>
  );
}

function AdminWorkspace({ all }: { all: readonly ApiCase[] }): ReactNode {
  const users = useUsers();

  return (
    <div className="space-y-6">
      <Card
        title="Users and roles"
        subtitle="A user holds many roles and receives the union of their permissions"
      >
        {users.loading ? (
          <Empty>Loading…</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs text-ink-500">
                <th className="pb-2 font-medium">User</th>
                <th className="pb-2 font-medium">Roles</th>
                <th className="pb-2 font-medium">Cases owned</th>
                <th className="pb-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {users.users.map((user) => (
                <tr key={user.id}>
                  <td className="py-2">{user.fullName}</td>
                  <td className="py-2 text-ink-500">{user.roles.join(", ")}</td>
                  <td className="tnum py-2">
                    {all.filter((c) => c.ownerUserId === user.id).length}
                  </td>
                  <td className="py-2">
                    {user.isActive ? (
                      <Badge tone="good">Active</Badge>
                    ) : (
                      <Badge tone="neutral">Deactivated</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Pending
        title="Recent activity"
        what="The audit log records administrative actions already. Case and customer events join it when their writes move to the server."
      />
    </div>
  );
}
