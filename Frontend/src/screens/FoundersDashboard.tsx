/**
 * The Founders Dashboard — the Manager/Managing Partner command centre.
 *
 * WHERE THIS LIVES: rendered by `WorkspaceHome` in place of the old
 * `ManagementWorkspace` panel, for the same "management" workspace those two
 * roles already land in (`session.tsx`'s `DEFAULT_WORKSPACE`/`WORKSPACE_ROLES`).
 * The landing route is therefore the existing workspace architecture, not a
 * new one — a Telecaller or Login Executive never reaches this component,
 * because their workspace is never "management".
 *
 * SCOPE, DELIBERATELY: everything operationally useful to a founder except
 * revenue and commissions. Eight conceptual sections (Overview, Cases, Team,
 * Tasks, Documents, Banks, Activity, Settings) live inside this ONE screen,
 * switched by in-page state rather than eight routes — `/cases`, `/cases/:id`
 * and the admin screens already exist and are linked out to rather than
 * duplicated.
 *
 * REAL DATA ONLY. Every number here comes from `GET /api/cases`,
 * `GET /api/users`, `GET /api/master-data/thresholds`, and the two endpoints
 * added alongside this screen — `GET /api/events` (`listOrgEvents`,
 * Backend/events.ts) and `GET /api/submissions` (`listAllSubmissions`,
 * Backend/submissions.ts) — both thin, permission-gated reads over tables
 * that already exist, not new business logic. Every one of those permission
 * checks also runs again on the server; nothing here is a security boundary
 * (session.tsx's own rule, BR-060).
 *
 * "Needs attention" and "Tasks" are the one place this screen goes further
 * than a raw read: AOS has no task/communication/note API yet (the tables and
 * permissions exist, Backend has no routes for them), so this derives real,
 * closed-vocabulary signals — a case sitting past its stage's configured
 * threshold (`operational_threshold`, ADR-025), or a hold whose follow-up date
 * has passed — instead of inventing a task list. `deriveAttention` is the one
 * function both "Attention Required" and "Tasks" read from, so the two never
 * say something different about the same case.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import {
  CASE_STAGE_LABELS,
  CASE_STAGE_PROGRESSION,
  type CaseStage,
} from "@domain/case/stages.js";
import { ROLE_LABELS } from "@domain/permissions/index.js";

import { useUsers } from "../api/catalogue.js";
import { useApiQuery } from "../api/hooks.js";
import { useThresholds } from "../api/master-data.js";
import type {
  ApiCase,
  ApiHealthDetail,
  ApiOrgEvent,
  ApiSubmissionBoardEntry,
  ApiThreshold,
  ApiUser,
  SubmissionStatus,
} from "../api/types.js";
import { when } from "../lib.js";
import { useSession } from "../session.js";
import { Badge, Button, Card, Empty, StageBadge, TABLE_ROW, Table, Td, Th, cx } from "../ui/index.js";
import { SUBMISSION_STATUS_LABELS, statusTone } from "./BanksTab.js";

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

type Section =
  | "overview"
  | "cases"
  | "team"
  | "tasks"
  | "documents"
  | "banks"
  | "activity"
  | "settings";

const DESKTOP_SECTIONS: readonly Section[] = [
  "overview",
  "cases",
  "team",
  "tasks",
  "documents",
  "banks",
  "activity",
  "settings",
];

const SECTION_LABELS: Record<Section, string> = {
  overview: "Overview",
  cases: "Cases",
  team: "Team",
  tasks: "Tasks",
  documents: "Documents",
  banks: "Banks",
  activity: "Activity",
  settings: "Settings",
};

const MOBILE_PRIMARY: readonly Section[] = ["overview", "cases", "tasks", "activity"];
const MOBILE_MORE = ["team", "documents", "banks", "settings"] as const satisfies readonly Section[];

const MORE_HINTS: Record<(typeof MOBILE_MORE)[number], string> = {
  team: "Workload and bottlenecks",
  documents: "Files waiting on paperwork",
  banks: "Progress with lenders",
  settings: "Founder-level configuration",
};

const LIVE_SUBMISSION_STATUSES = new Set<SubmissionStatus>([
  "submitted",
  "under_process",
  "query_raised",
  "eligibility_received",
]);

// ---------------------------------------------------------------------------
// Derived data — pure, shared by more than one section
// ---------------------------------------------------------------------------

function idleThresholdsByStage(thresholds: readonly ApiThreshold[]): Partial<Record<CaseStage, number>> {
  const map: Partial<Record<CaseStage, number>> = {};
  for (const threshold of thresholds) {
    if (threshold.key.startsWith("idle_days.")) {
      map[threshold.key.slice("idle_days.".length) as CaseStage] = threshold.valueDays;
    }
  }
  return map;
}

interface AttentionItem {
  readonly loanCase: ApiCase;
  readonly kind: "stalled" | "hold_overdue";
  readonly daysIdle: number;
  readonly thresholdDays: number | null;
}

/**
 * The one place "needs attention" is decided. `updatedAt` is an approximation
 * of "time in this stage" — it is a generic touch trigger, not a
 * `stage_entered_at` column (none exists) — but it is the strongest signal
 * the data model currently offers, compared against the real, founder-editable
 * per-stage thresholds rather than a hardcoded number.
 */
function deriveAttention(
  cases: readonly ApiCase[],
  idleDaysByStage: Partial<Record<CaseStage, number>>,
): AttentionItem[] {
  const now = Date.now();
  const items: AttentionItem[] = [];

  for (const loanCase of cases) {
    if (loanCase.isOnHold) {
      if (loanCase.holdUntil && new Date(loanCase.holdUntil).getTime() < now) {
        items.push({
          loanCase,
          kind: "hold_overdue",
          daysIdle: (now - new Date(loanCase.holdUntil).getTime()) / 86400000,
          thresholdDays: null,
        });
      }
      continue;
    }
    const threshold = idleDaysByStage[loanCase.stage];
    if (threshold === undefined) continue;
    const daysIdle = (now - new Date(loanCase.updatedAt).getTime()) / 86400000;
    if (daysIdle >= threshold) {
      items.push({ loanCase, kind: "stalled", daysIdle, thresholdDays: threshold });
    }
  }

  return items.sort((a, b) => b.daysIdle - a.daysIdle);
}

interface TeamRow {
  readonly user: ApiUser;
  readonly activeCases: number;
  readonly attentionCount: number;
  readonly onHoldCount: number;
}

function buildTeamRows(
  users: readonly ApiUser[],
  active: readonly ApiCase[],
  attentionCaseIds: ReadonlySet<string>,
): TeamRow[] {
  return users
    .filter((user) => user.isActive)
    .map((user) => {
      const owned = active.filter((c) => c.ownerUserId === user.id);
      return {
        user,
        activeCases: owned.length,
        attentionCount: owned.filter((c) => attentionCaseIds.has(c.id)).length,
        onHoldCount: owned.filter((c) => c.isOnHold).length,
      };
    })
    .sort((a, b) => b.activeCases - a.activeCases);
}

interface BankGroup {
  readonly counterparty: string;
  readonly live: number;
  readonly sanctioned: number;
  readonly rejected: number;
  readonly total: number;
}

function buildBankGroups(submissions: readonly ApiSubmissionBoardEntry[]): BankGroup[] {
  const byBank = new Map<string, { live: number; sanctioned: number; rejected: number; total: number }>();
  for (const submission of submissions) {
    const group = byBank.get(submission.counterparty) ?? { live: 0, sanctioned: 0, rejected: 0, total: 0 };
    group.total += 1;
    if (LIVE_SUBMISSION_STATUSES.has(submission.status)) group.live += 1;
    if (submission.status === "sanctioned" || submission.status === "disbursed") group.sanctioned += 1;
    if (submission.status === "rejected") group.rejected += 1;
    byBank.set(submission.counterparty, group);
  }
  return Array.from(byBank.entries())
    .map(([counterparty, group]) => ({ counterparty, ...group }))
    .sort((a, b) => b.live - a.live || b.total - a.total);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function FoundersDashboard({
  all,
  active,
  loading,
}: {
  all: readonly ApiCase[];
  active: readonly ApiCase[];
  loading: boolean;
}): ReactNode {
  const session = useSession();
  const users = useUsers();
  const thresholds = useThresholds();

  const eventsAllowed = session.can("event.view", "all");
  const submissionsAllowed = session.can("submission.read", "all");
  const events = useApiQuery<readonly ApiOrgEvent[]>(eventsAllowed ? "/events?limit=30" : null);
  const submissions = useApiQuery<readonly ApiSubmissionBoardEntry[]>(
    submissionsAllowed ? "/submissions?limit=300" : null,
  );
  const health = useApiQuery<ApiHealthDetail>("/health/detail");

  const [section, setSection] = useState<Section>("overview");
  const [showMore, setShowMore] = useState(false);

  const idleDaysByStage = useMemo(() => idleThresholdsByStage(thresholds.thresholds), [thresholds.thresholds]);
  const attention = useMemo(() => deriveAttention(active, idleDaysByStage), [active, idleDaysByStage]);
  const casesById = useMemo(() => new Map(all.map((c) => [c.id, c] as const)), [all]);
  const submissionRows = submissions.data ?? [];
  const eventRows = events.data ?? [];

  const selectSection = (next: Section): void => {
    setSection(next);
    setShowMore(false);
  };

  if (loading) {
    return <Empty>Loading the dashboard…</Empty>;
  }

  return (
    <div className="pb-20 sm:pb-0">
      <Greeting name={session.displayName} />

      <div className="mt-8">
        <DesktopSectionNav section={section} onChange={selectSection} />
      </div>

      <div key={showMore ? "more" : section} className="aos-animate-in mt-7">
        {showMore ? (
          <MoreMenu onSelect={selectSection} />
        ) : section === "overview" ? (
          <OverviewSection
            all={all}
            active={active}
            attention={attention}
            users={users}
            submissions={submissionRows}
            events={eventRows}
            health={health.data}
            eventsAllowed={eventsAllowed}
            submissionsAllowed={submissionsAllowed}
            onNavigate={selectSection}
          />
        ) : section === "cases" ? (
          <CasesSection all={all} active={active} attention={attention} ownerName={users.ownerName} />
        ) : section === "team" ? (
          <TeamSection
            rows={buildTeamRows(users.users, active, new Set(attention.map((item) => item.loanCase.id)))}
            loading={users.loading}
          />
        ) : section === "tasks" ? (
          <TasksSection attention={attention} ownerName={users.ownerName} />
        ) : section === "documents" ? (
          <DocumentsSection active={active} ownerName={users.ownerName} />
        ) : section === "banks" ? (
          <BanksSection
            submissions={submissionRows}
            casesById={casesById}
            loading={submissionsAllowed && submissions.loading}
            allowed={submissionsAllowed}
          />
        ) : section === "activity" ? (
          <ActivitySection events={eventRows} loading={eventsAllowed && events.loading} allowed={eventsAllowed} />
        ) : (
          <SettingsSection />
        )}
      </div>

      <MobileBottomNav
        section={section}
        moreActive={showMore || MOBILE_MORE.includes(section as (typeof MOBILE_MORE)[number])}
        onSelect={selectSection}
        onMore={() => setShowMore(true)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Greeting
// ---------------------------------------------------------------------------

function greetingWord(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function Greeting({ name }: { name: string }): ReactNode {
  const [hour] = useState(() => new Date().getHours());
  return (
    <div>
      {/* A short gold rule rather than a coloured word — the one signature
          mark on the page that isn't tied to a status, sitting where a
          founder's eye lands first. */}
      <div className="mb-3 h-0.5 w-9 rounded-full bg-gold-500" aria-hidden />
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-900 sm:text-4xl">
        {greetingWord(hour)}, {name}
      </h1>
      <p className="mt-2 text-sm text-ink-500">Here's what's happening across Amaze today.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function DesktopSectionNav({
  section,
  onChange,
}: {
  section: Section;
  onChange: (next: Section) => void;
}): ReactNode {
  return (
    <nav className="hidden gap-1 overflow-x-auto border-b border-ink-150 sm:flex">
      {DESKTOP_SECTIONS.map((item) => (
        <button
          key={item}
          onClick={() => onChange(item)}
          className={cx(
            "shrink-0 rounded-t-md border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors duration-150",
            section === item
              ? "border-brand-600 text-ink-900"
              : "border-transparent text-ink-500 hover:bg-ink-50/60 hover:text-ink-700",
          )}
        >
          {SECTION_LABELS[item]}
        </button>
      ))}
    </nav>
  );
}

function MobileNavButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      onClick={onClick}
      className={cx(
        "relative flex-1 py-3 text-center text-xs font-medium transition-colors duration-150",
        active ? "text-brand-700" : "text-ink-500 active:text-ink-700",
      )}
    >
      {active && <span aria-hidden className="absolute inset-x-1/4 top-0 h-0.5 rounded-full bg-brand-600" />}
      {label}
    </button>
  );
}

function MobileBottomNav({
  section,
  moreActive,
  onSelect,
  onMore,
}: {
  section: Section;
  moreActive: boolean;
  onSelect: (next: Section) => void;
  onMore: () => void;
}): ReactNode {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-ink-150 bg-white/95 backdrop-blur sm:hidden">
      {MOBILE_PRIMARY.map((item) => (
        <MobileNavButton
          key={item}
          label={SECTION_LABELS[item]}
          active={!moreActive && section === item}
          onClick={() => onSelect(item)}
        />
      ))}
      <MobileNavButton label="More" active={moreActive} onClick={onMore} />
    </nav>
  );
}

function MoreMenu({ onSelect }: { onSelect: (next: Section) => void }): ReactNode {
  return (
    <div className="grid gap-3 sm:hidden">
      {MOBILE_MORE.map((item) => (
        <button
          key={item}
          onClick={() => onSelect(item)}
          className="flex items-center justify-between rounded-lg bg-white p-4 text-left ring-1 ring-ink-150 transition-shadow duration-150 hover:shadow-elevated"
        >
          <span>
            <span className="block text-sm font-medium text-ink-900">{SECTION_LABELS[item]}</span>
            <span className="block text-xs text-ink-500">{MORE_HINTS[item]}</span>
          </span>
          <span aria-hidden className="text-ink-300">
            →
          </span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared row/tile pieces
// ---------------------------------------------------------------------------

/**
 * `primary` is for the two or three numbers a founder actually opens this
 * screen to check — everything else is `secondary`. The difference is size,
 * padding and elevation, not colour: colour still belongs to `warn` alone.
 */
function StatTile({
  label,
  value,
  hint,
  warn,
  primary = false,
}: {
  label: string;
  value: string;
  hint?: string;
  warn?: boolean;
  primary?: boolean;
}): ReactNode {
  return (
    <div
      className={cx(
        "rounded-lg bg-white ring-1 transition-shadow duration-200",
        primary ? "p-5 shadow-elevated ring-ink-150" : "p-4 ring-ink-100 hover:shadow-soft",
      )}
    >
      <p className="text-xs font-medium text-ink-500">{label}</p>
      <p
        className={cx(
          "font-display tnum mt-1.5 font-semibold tracking-tight",
          primary ? "text-4xl" : "text-2xl",
          warn ? "text-amber-700" : "text-ink-900",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
    </div>
  );
}

function CaseMiniRow({
  loanCase,
  ownerName,
  trailing,
}: {
  loanCase: ApiCase;
  ownerName: (id: string | null | undefined) => string;
  trailing?: ReactNode;
}): ReactNode {
  return (
    <li className="py-2.5 first:pt-0 last:pb-0">
      <Link to={`/cases/${loanCase.id}`} className="flex flex-wrap items-center gap-2">
        <span className="tnum text-sm font-medium text-ink-900 hover:underline">{loanCase.caseNumber}</span>
        <span className="text-sm text-ink-700">{loanCase.applicantName ?? "No applicant"}</span>
        <span className="ml-auto flex items-center gap-2">
          {trailing}
          <StageBadge stage={loanCase.stage} label={CASE_STAGE_LABELS[loanCase.stage]} />
        </span>
      </Link>
      <p className="mt-0.5 text-xs text-ink-500">
        {ownerName(loanCase.ownerUserId)} · last touched {when(loanCase.updatedAt)}
      </p>
    </li>
  );
}

function AttentionRow({
  item,
  ownerName,
}: {
  item: AttentionItem;
  ownerName: (id: string | null | undefined) => string;
}): ReactNode {
  const label =
    item.kind === "hold_overdue"
      ? `Hold follow-up ${Math.round(item.daysIdle)}d overdue`
      : `${Math.round(item.daysIdle)}d in stage (limit ${item.thresholdDays}d)`;
  // Restrained severity, not a bigger warning: a case that has drifted twice
  // its stage's normal pace (or a hold follow-up, which has no "mild" form)
  // reads as `bad` instead of `warn` — the same badge, a stronger colour,
  // nothing louder than that.
  const severe = item.kind === "hold_overdue" || (item.thresholdDays !== null && item.daysIdle >= item.thresholdDays * 2);
  return (
    <CaseMiniRow
      loanCase={item.loanCase}
      ownerName={ownerName}
      trailing={<Badge tone={severe ? "bad" : "warn"}>{label}</Badge>}
    />
  );
}

function PipelineChart({ all }: { all: readonly ApiCase[] }): ReactNode {
  const counts = useMemo(() => {
    const map = new Map<CaseStage, number>();
    for (const stage of CASE_STAGE_PROGRESSION) map.set(stage, 0);
    for (const loanCase of all) {
      if (map.has(loanCase.stage)) map.set(loanCase.stage, (map.get(loanCase.stage) ?? 0) + 1);
    }
    return map;
  }, [all]);

  const max = Math.max(1, ...Array.from(counts.values()));
  const closed = all.filter((c) => c.stage === "closed").length;
  const lost = all.filter((c) => c.stage === "lost").length;

  // The one stage genuinely holding the most cases — the bottleneck a
  // founder actually wants to see at a glance. Ties and an empty pipeline
  // both resolve to "no bottleneck": a mark on every stage would mean nothing
  // (ADR-011's own logic applied here — a signal that always fires is noise).
  const bottleneck = useMemo(() => {
    let winner: CaseStage | null = null;
    let ties = 0;
    for (const stage of CASE_STAGE_PROGRESSION) {
      const count = counts.get(stage) ?? 0;
      if (count === 0) continue;
      if (winner === null || count > (counts.get(winner) ?? 0)) {
        winner = stage;
        ties = 1;
      } else if (count === counts.get(winner)) {
        ties += 1;
      }
    }
    return ties === 1 ? winner : null;
  }, [counts]);

  return (
    <div>
      {/* A thin spine running through every stage's marker reads as one flow
          rather than eight independent bars — the connective tissue a plain
          stack of progress rows was missing. */}
      <div className="relative space-y-3 pl-1">
        <div aria-hidden className="absolute top-1 bottom-1 left-[7px] w-px bg-ink-150" />
        {CASE_STAGE_PROGRESSION.map((stage) => {
          const count = counts.get(stage) ?? 0;
          const isBottleneck = stage === bottleneck;
          return (
            <div key={stage} className="relative flex items-center gap-3 pl-6">
              <span
                aria-hidden
                className={cx(
                  "absolute top-1/2 left-0 h-[7px] w-[7px] -translate-y-1/2 rounded-full ring-2 ring-canvas",
                  isBottleneck ? "bg-gold-500" : count > 0 ? "bg-brand-400" : "bg-ink-200",
                )}
              />
              <span className="w-36 shrink-0 text-xs text-ink-600">{CASE_STAGE_LABELS[stage]}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100">
                <div
                  className={cx(
                    "h-full rounded-full transition-all duration-300 ease-out",
                    isBottleneck ? "bg-gold-500" : "bg-brand-500",
                  )}
                  style={{ width: `${(count / max) * 100}%` }}
                />
              </div>
              <span
                className={cx(
                  "tnum w-6 shrink-0 text-right text-xs",
                  isBottleneck ? "font-semibold text-ink-900" : "font-medium text-ink-700",
                )}
              >
                {count}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-ink-400">
        Outcomes, all time — Closed {closed} · Lost {lost}
        {bottleneck && (
          <>
            {" "}
            · <span className="text-gold-700">Most volume sitting in {CASE_STAGE_LABELS[bottleneck]}</span>
          </>
        )}
      </p>
    </div>
  );
}

function HealthChip({ label, state }: { label: string; state: "up" | "down" | "unconfigured" }): ReactNode {
  const tone = state === "up" ? "good" : state === "unconfigured" ? "neutral" : "bad";
  const text = state === "up" ? "Operational" : state === "unconfigured" ? "Not configured" : "Down";
  return (
    <div className="flex items-center justify-between rounded-md bg-ink-50 px-3 py-2">
      <span className="text-sm text-ink-700">{label}</span>
      <Badge tone={tone}>{text}</Badge>
    </div>
  );
}

function OperationalHealthCard({ health }: { health: ApiHealthDetail | undefined }): ReactNode {
  return (
    <Card title="System health" subtitle="What AOS itself depends on">
      {!health ? (
        <Empty>Checking…</Empty>
      ) : (
        <div className="space-y-2">
          <HealthChip label="Database" state={health.database} />
          <HealthChip label="Document storage" state={health.storage} />
          <HealthChip label="Mail delivery" state={health.mail} />
        </div>
      )}
    </Card>
  );
}

function ViewAllButton({ onClick }: { onClick: () => void }): ReactNode {
  return (
    <button onClick={onClick} className="text-xs font-medium text-brand-700 hover:underline">
      View all
    </button>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewSection({
  all,
  active,
  attention,
  users,
  submissions,
  events,
  health,
  eventsAllowed,
  submissionsAllowed,
  onNavigate,
}: {
  all: readonly ApiCase[];
  active: readonly ApiCase[];
  attention: readonly AttentionItem[];
  users: ReturnType<typeof useUsers>;
  submissions: readonly ApiSubmissionBoardEntry[];
  events: readonly ApiOrgEvent[];
  health: ApiHealthDetail | undefined;
  eventsAllowed: boolean;
  submissionsAllowed: boolean;
  onNavigate: (section: Section) => void;
}): ReactNode {
  const newLeads = active.filter(
    (c) => Date.now() - new Date(c.createdAt).getTime() <= 7 * 86400000,
  ).length;
  const pendingDocs = active.filter(
    (c) => c.progress && c.progress.applicableCount > 0 && c.progress.percentComplete < 100,
  ).length;
  const liveApplications = submissions.filter((s) => LIVE_SUBMISSION_STATUSES.has(s.status)).length;

  const attentionIds = useMemo(() => new Set(attention.map((item) => item.loanCase.id)), [attention]);
  const teamRows = useMemo(() => buildTeamRows(users.users, active, attentionIds).slice(0, 4), [users.users, active, attentionIds]);
  const bankGroups = useMemo(() => buildBankGroups(submissions).slice(0, 4), [submissions]);

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        {/* The business pulse: two numbers a founder is here to see, given
            room to breathe, with the rest of the count as a quieter second
            row rather than five equal tiles competing for the same glance. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <StatTile label="Active cases" value={String(active.length)} primary />
          <StatTile
            label="Needs attention"
            value={String(attention.length)}
            warn={attention.length > 0}
            primary
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile label="New leads" value={String(newLeads)} hint="Last 7 days" />
          <StatTile label="Pending documents" value={String(pendingDocs)} />
          <StatTile
            label="With a bank"
            value={submissionsAllowed ? String(liveApplications) : "—"}
            hint="Live applications"
          />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Pipeline" subtitle="Volume by stage" elevated className="lg:col-span-2">
          <PipelineChart all={all} />
        </Card>
        <Card
          title="Needs attention"
          subtitle={`Top ${Math.min(5, attention.length)} of ${attention.length}`}
          actions={attention.length > 0 && <ViewAllButton onClick={() => onNavigate("tasks")} />}
          elevated={attention.length > 0}
        >
          {attention.length === 0 ? (
            <Empty>Everything is moving at a healthy pace.</Empty>
          ) : (
            <ul className="divide-y divide-ink-100">
              {attention.slice(0, 5).map((item) => (
                <AttentionRow key={item.loanCase.id} item={item} ownerName={users.ownerName} />
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Team"
          subtitle="Busiest owners right now"
          actions={<ViewAllButton onClick={() => onNavigate("team")} />}
        >
          {teamRows.length === 0 ? (
            <Empty>No active team members.</Empty>
          ) : (
            <ul className="divide-y divide-ink-100">
              {teamRows.map((row) => (
                <li key={row.user.id} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                  <span className="text-sm font-medium text-ink-900">{row.user.fullName}</span>
                  <span className="flex items-center gap-3 text-xs text-ink-500">
                    <span className="tnum">{row.activeCases} active</span>
                    {row.attentionCount > 0 && <Badge tone="warn">{row.attentionCount} attention</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Recent activity"
          subtitle="Across the organisation"
          actions={eventsAllowed && <ViewAllButton onClick={() => onNavigate("activity")} />}
        >
          {!eventsAllowed ? (
            <Empty>Not available with your current permissions.</Empty>
          ) : events.length === 0 ? (
            <Empty>Nothing recorded yet.</Empty>
          ) : (
            <ul className="divide-y divide-ink-100">
              {events.slice(0, 6).map((event) => (
                <li key={event.id} className="py-2 first:pt-0 last:pb-0">
                  <p className="text-sm text-ink-700">
                    <span className="tnum font-medium text-ink-900">{event.caseNumber}</span> · {event.label}
                  </p>
                  <p className="text-xs text-ink-400">{when(event.occurredAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card
          title="Banks"
          subtitle="By lender"
          actions={submissionsAllowed && <ViewAllButton onClick={() => onNavigate("banks")} />}
        >
          {!submissionsAllowed ? (
            <Empty>Not available with your current permissions.</Empty>
          ) : bankGroups.length === 0 ? (
            <Empty>No submissions yet.</Empty>
          ) : (
            <ul className="space-y-2">
              {bankGroups.map((group) => (
                <li key={group.counterparty} className="flex items-center justify-between text-sm">
                  <span className="truncate text-ink-700">{group.counterparty}</span>
                  <span className="tnum shrink-0 text-ink-500">{group.live} live</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Documents"
          subtitle="Cases waiting on paperwork"
          actions={<ViewAllButton onClick={() => onNavigate("documents")} />}
        >
          <p className="font-display tnum text-3xl font-semibold text-ink-900">{pendingDocs}</p>
          <p className="mt-1 text-xs text-ink-500">
            active case{pendingDocs === 1 ? "" : "s"} with outstanding requirements
          </p>
        </Card>

        <OperationalHealthCard health={health} />
      </div>

      <QuickActions onNavigate={onNavigate} />
    </div>
  );
}

function QuickActions({ onNavigate }: { onNavigate: (section: Section) => void }): ReactNode {
  const session = useSession();
  return (
    <Card title="Quick actions">
      <div className="flex flex-wrap gap-2">
        {session.can("case.create", "all") && (
          <Link to="/cases/new">
            <Button variant="primary">New case</Button>
          </Link>
        )}
        <Link to="/cases">
          <Button variant="secondary">All cases</Button>
        </Link>
        <Button variant="secondary" onClick={() => onNavigate("tasks")}>
          Cases needing attention
        </Button>
        {session.can("user.manage", "all") && (
          <Link to="/admin/users">
            <Button variant="secondary">Manage users</Button>
          </Link>
        )}
        {session.can("master_data.manage", "all") && (
          <Link to="/admin/master-data">
            <Button variant="secondary">Master data</Button>
          </Link>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Cases (Leads & Cases)
// ---------------------------------------------------------------------------

function CasesSection({
  all,
  active,
  attention,
  ownerName,
}: {
  all: readonly ApiCase[];
  active: readonly ApiCase[];
  attention: readonly AttentionItem[];
  ownerName: (id: string | null | undefined) => string;
}): ReactNode {
  const onHold = active.filter((c) => c.isOnHold);

  return (
    <div className="space-y-6">
      <Card title="Pipeline" subtitle="Where every active case sits right now">
        <PipelineChart all={all} />
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Needs attention"
          subtitle={`${attention.length} case${attention.length === 1 ? "" : "s"} past their stage's normal pace, or overdue for hold follow-up`}
        >
          {attention.length === 0 ? (
            <Empty>Everything is moving at a healthy pace.</Empty>
          ) : (
            <ul className="divide-y divide-ink-100">
              {attention.map((item) => (
                <AttentionRow key={item.loanCase.id} item={item} ownerName={ownerName} />
              ))}
            </ul>
          )}
        </Card>

        <Card title="On hold" subtitle="Parked deliberately, with a reason on each">
          {onHold.length === 0 ? (
            <Empty>Nothing on hold.</Empty>
          ) : (
            <ul className="divide-y divide-ink-100">
              {onHold.map((loanCase) => (
                <CaseMiniRow
                  key={loanCase.id}
                  loanCase={loanCase}
                  ownerName={ownerName}
                  trailing={loanCase.holdReason ? <Badge tone="neutral">{loanCase.holdReason}</Badge> : undefined}
                />
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="text-right">
        <Link to="/cases" className="text-sm font-medium text-brand-700 hover:underline">
          Open the full case list →
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

function TeamSection({ rows, loading }: { rows: readonly TeamRow[]; loading: boolean }): ReactNode {
  return (
    <Card title="Team workload" subtitle="Active cases currently owned, and where attention is concentrated">
      {loading ? (
        <Empty>Loading…</Empty>
      ) : rows.length === 0 ? (
        <Empty>No active team members.</Empty>
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-ink-150 text-left">
              <Th>Team member</Th>
              <Th>Role</Th>
              <Th align="right">Active cases</Th>
              <Th align="right">Needs attention</Th>
              <Th align="right">On hold</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.user.id} className={TABLE_ROW}>
                <Td className="font-medium whitespace-nowrap text-ink-900">{row.user.fullName}</Td>
                <Td muted className="whitespace-nowrap">
                  {row.user.roles.map((role) => ROLE_LABELS[role]).join(", ")}
                </Td>
                <Td align="right" className="tnum">
                  {row.activeCases}
                </Td>
                <Td align="right" className="tnum">
                  {row.attentionCount > 0 ? (
                    <Badge tone="warn">{row.attentionCount}</Badge>
                  ) : (
                    <span className="text-ink-300">0</span>
                  )}
                </Td>
                <Td align="right" muted className="tnum">
                  {row.onHoldCount}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Tasks — the derived action queue (see file header)
// ---------------------------------------------------------------------------

function TasksSection({
  attention,
  ownerName,
}: {
  attention: readonly AttentionItem[];
  ownerName: (id: string | null | undefined) => string;
}): ReactNode {
  const overdueHolds = attention.filter((item) => item.kind === "hold_overdue");
  const stalled = attention.filter((item) => item.kind === "stalled");

  return (
    <div className="space-y-6">
      <p className="text-xs text-ink-500">
        Derived from real case activity — hold follow-ups past their date, and cases sitting longer than
        their stage's configured pace (Settings → Operational thresholds). AOS has no separate task list
        yet; this is the strongest signal on file for "what needs a founder's attention."
      </p>

      <Card
        title="Hold follow-ups overdue"
        subtitle={`${overdueHolds.length} case${overdueHolds.length === 1 ? "" : "s"}`}
      >
        {overdueHolds.length === 0 ? (
          <Empty>No overdue hold follow-ups.</Empty>
        ) : (
          <ul className="divide-y divide-ink-100">
            {overdueHolds.map((item) => (
              <AttentionRow key={item.loanCase.id} item={item} ownerName={ownerName} />
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Stalled in stage"
        subtitle={`${stalled.length} case${stalled.length === 1 ? "" : "s"} past their stage's normal pace`}
      >
        {stalled.length === 0 ? (
          <Empty>Nothing stalled right now.</Empty>
        ) : (
          <ul className="divide-y divide-ink-100">
            {stalled.map((item) => (
              <AttentionRow key={item.loanCase.id} item={item} ownerName={ownerName} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function DocumentsSection({
  active,
  ownerName,
}: {
  active: readonly ApiCase[];
  ownerName: (id: string | null | undefined) => string;
}): ReactNode {
  const pending = active
    .filter((c) => c.progress && c.progress.applicableCount > 0 && c.progress.percentComplete < 100)
    .sort((a, b) => (a.progress?.percentComplete ?? 0) - (b.progress?.percentComplete ?? 0));

  return (
    <Card
      title="Waiting on documents"
      subtitle={`${pending.length} active case${pending.length === 1 ? "" : "s"} with outstanding requirements, least complete first`}
    >
      {pending.length === 0 ? (
        <Empty>Nothing waiting on documents.</Empty>
      ) : (
        <ul className="divide-y divide-ink-100">
          {pending.map((loanCase) => (
            <CaseMiniRow
              key={loanCase.id}
              loanCase={loanCase}
              ownerName={ownerName}
              trailing={
                <span className="tnum text-xs text-ink-500">{loanCase.progress?.percentComplete}% verified</span>
              }
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Banks / Applications
// ---------------------------------------------------------------------------

function BanksSection({
  submissions,
  casesById,
  loading,
  allowed,
}: {
  submissions: readonly ApiSubmissionBoardEntry[];
  casesById: Map<string, ApiCase>;
  loading: boolean;
  allowed: boolean;
}): ReactNode {
  const groups = useMemo(() => buildBankGroups(submissions), [submissions]);
  const recent = submissions.slice(0, 20);

  if (!allowed) {
    return (
      <Card title="Banks / Applications">
        <Empty>You do not have permission to view submissions across cases.</Empty>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card title="By lender" subtitle="Live, sanctioned and rejected counts across every submission on file">
        {loading ? (
          <Empty>Loading…</Empty>
        ) : groups.length === 0 ? (
          <Empty>No submissions yet.</Empty>
        ) : (
          <Table>
            <thead>
              <tr className="border-b border-ink-150 text-left">
                <Th>Lender</Th>
                <Th align="right">Live</Th>
                <Th align="right">Sanctioned</Th>
                <Th align="right">Rejected</Th>
                <Th align="right">Total</Th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.counterparty} className={TABLE_ROW}>
                  <Td className="font-medium whitespace-nowrap text-ink-900">{group.counterparty}</Td>
                  <Td align="right" className="tnum">
                    {group.live}
                  </Td>
                  <Td align="right" className="tnum text-emerald-700">
                    {group.sanctioned}
                  </Td>
                  <Td align="right" className="tnum text-red-700">
                    {group.rejected}
                  </Td>
                  <Td align="right" muted className="tnum">
                    {group.total}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Recent submissions" subtitle="Most recent first">
        {loading ? (
          <Empty>Loading…</Empty>
        ) : recent.length === 0 ? (
          <Empty>Nothing submitted yet.</Empty>
        ) : (
          <ul className="divide-y divide-ink-100">
            {recent.map((submission) => {
              const loanCase = casesById.get(submission.caseId);
              return (
                <li key={submission.id} className="py-2.5 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {loanCase ? (
                      <Link
                        to={`/cases/${loanCase.id}`}
                        className="tnum text-sm font-medium text-ink-900 hover:underline"
                      >
                        {loanCase.caseNumber}
                      </Link>
                    ) : (
                      <span className="text-sm text-ink-400">Case unavailable</span>
                    )}
                    <span className="text-sm text-ink-700">{submission.counterparty}</span>
                    <span className="ml-auto">
                      <Badge tone={statusTone(submission.status)}>
                        {SUBMISSION_STATUS_LABELS[submission.status]}
                      </Badge>
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-500">
                    {submission.submittedAt
                      ? `Submitted ${when(submission.submittedAt)}`
                      : `Created ${when(submission.createdAt)}`}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function ActivitySection({
  events,
  loading,
  allowed,
}: {
  events: readonly ApiOrgEvent[];
  loading: boolean;
  allowed: boolean;
}): ReactNode {
  if (!allowed) {
    return (
      <Card title="Recent activity">
        <Empty>You do not have permission to view organisation-wide activity.</Empty>
      </Card>
    );
  }

  return (
    <Card title="Recent activity" subtitle="Case events across the organisation, most recent first">
      {loading ? (
        <Empty>Loading…</Empty>
      ) : events.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        <ul className="divide-y divide-ink-100">
          {events.map((event) => (
            <li key={event.id} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  to={`/cases/${event.caseId}`}
                  className="tnum text-sm font-medium text-ink-900 hover:underline"
                >
                  {event.caseNumber}
                </Link>
                <span className="text-sm text-ink-700">{event.label}</span>
                <span className="ml-auto text-xs text-ink-400">{when(event.occurredAt)}</span>
              </div>
              <p className="mt-0.5 text-xs text-ink-500">
                {event.actorKind === "system" ? "System" : (event.actorName ?? "Someone")}
                {event.detail ? ` · ${event.detail}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function SettingsSection(): ReactNode {
  const session = useSession();
  const thresholds = useThresholds();

  const links = [
    {
      to: "/admin/users",
      label: "Users & roles",
      hint: "Accounts, roles and permission overrides",
      show: session.can("user.manage", "all"),
    },
    {
      to: "/admin/master-data",
      label: "Master data",
      hint: "Document types, rejection reasons, rules and thresholds",
      show: session.can("master_data.manage", "all"),
    },
    {
      to: "/admin/lending-products",
      label: "Lending products",
      hint: "The loan products AOS offers",
      show: session.can("master_data.manage", "all"),
    },
    {
      to: "/admin/lenders",
      label: "Lenders",
      hint: "The bank and branch catalogue",
      show: session.can("master_data.manage", "all"),
    },
    {
      to: "/admin/document-rules",
      label: "Document rules",
      hint: "Which documents each case requires, and when",
      show: session.can("master_data.manage", "all"),
    },
  ].filter((link) => link.show);

  return (
    <div className="space-y-6">
      <Card title="Configuration" subtitle="Founder-level settings, each in its own screen">
        {links.length === 0 ? (
          <Empty>Nothing configurable with your current permissions.</Empty>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {links.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className="flex items-center justify-between rounded-lg bg-white p-4 text-left ring-1 ring-ink-150 transition-shadow duration-150 hover:shadow-elevated"
              >
                <span>
                  <span className="block text-sm font-medium text-ink-900">{link.label}</span>
                  <span className="block text-xs text-ink-500">{link.hint}</span>
                </span>
                <span aria-hidden className="text-ink-300">
                  →
                </span>
              </Link>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Operational thresholds"
        subtitle="How many days a case may sit before it needs attention — what powers this dashboard's Attention Required and Tasks"
      >
        {thresholds.loading ? (
          <Empty>Loading…</Empty>
        ) : (
          <ul className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
            {thresholds.thresholds.map((threshold) => (
              <li key={threshold.key} className="flex items-center justify-between border-b border-ink-50 py-1">
                <span className="text-ink-700">{threshold.description ?? threshold.key}</span>
                <span className="tnum font-medium text-ink-900">{threshold.valueDays}d</span>
              </li>
            ))}
          </ul>
        )}
        {session.can("master_data.manage", "all") && (
          <p className="mt-3 text-xs text-ink-500">
            Edit these in{" "}
            <Link to="/admin/master-data" className="font-medium text-brand-700 hover:underline">
              Master Data → Thresholds
            </Link>
            .
          </p>
        )}
      </Card>
    </div>
  );
}
