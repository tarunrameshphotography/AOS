/**
 * The case screen — the centre of the system.
 *
 * The layout follows ADR-004: the case stage is prominent and the submission
 * grid is immediately beneath it, so the relationship between the two axes is
 * obvious rather than explained.
 *
 * Everything that can be refused is refused by the domain layer, and the
 * refusal's own words are shown. A guard that says "4 requirements still
 * outstanding" is more useful than a disabled button.
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
import { evaluateTransition } from "@domain/case/transitions.js";
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_HINTS,
  DOCUMENT_CATEGORY_LABELS,
  documentRowLabel,
  isFinancialYearScoped,
  type DocumentCategory,
} from "@domain/requirements/document-catalogue.js";
import { financialYearOf } from "@domain/requirements/financial-year.js";
import { CONSTRUCTION_STAGES } from "@domain/requirements/rules.js";
import { versionHistory } from "@domain/storage/index.js";

import {
  acceptOffer,
  addCaseProperty,
  addCustomRequirement,
  addFinancialYearRequirement,
  addNote,
  addParty,
  assignOwner,
  changeLoanProduct,
  contactLabel,
  counterpartyOf,
  createSubmission,
  logCommunication,
  recipientsOf,
  moveStage,
  progressFor,
  reevaluateRequirements,
  rejectDocument,
  removeCaseProperty,
  removeCustomRequirement,
  removeDocument,
  ruleBehind,
  selectableFinancialYears,
  setHold,
  snapshotOf,
  updateCaseFacts,
  updateCaseProperty,
  updateOrganisation,
  updatePartyProfile,
  updateSubmissionStatus,
  uploadDocument,
  verifyDocument,
  waiveRequirement,
} from "../fake/store.js";
import { clearDraft, clearDrafts, getDraft, useDraft } from "../fake/drafts.js";
import { storageAdapter } from "../fake/storage.js";
import { useDatabase } from "../fake/useDatabase.js";
import type { CasePartyRole, DocumentFile, Id, SubmissionStatus } from "../fake/types.js";
import {
  CASE_TABS,
  CASE_TAB_LABELS,
  CASE_TAB_PURPOSE,
  nextCaseTab,
  previousCaseTab,
  resolveCaseTab,
  type CaseTab,
} from "./case-tabs.js";
import type { FyGroup } from "./document-financial-years.js";
import { financialYearGroups } from "./document-financial-years.js";
import {
  DOCUMENT_STATE_PRESENTATION,
  documentStateCounts,
  documentStateLabel,
  documentStateOf,
  documentStateTone,
  isDocumentCollectionComplete,
} from "./document-status.js";
import {
  bytes,
  enteredCurrentStageAt,
  exactly,
  lakhs,
  maskedPan,
  money,
  originatorName,
  ownerName,
  panOf,
  partyName,
  primaryApplicant,
  primaryPhone,
  productLabel,
  titleCase,
  waitingOn,
  when,
} from "../lib.js";
import { useSession } from "../session.js";
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
import { OrganisationSearchField, PersonSearchField } from "../ui/pickers.js";
import { StorageLocation } from "../ui/storage-location.js";

export function CaseDetail(): ReactNode {
  const { caseId = "" } = useParams();
  const db = useDatabase();
  const session = useSession();

  /**
   * Which tab, in the URL rather than in component state (Part 7).
   *
   * Three things fall out of that and all three were asked for: the browser's
   * back button walks back through the tabs instead of leaving the case; a
   * refresh returns to where the user was; and a link to "this case's
   * documents" is a link somebody can send. Component state gave none of the
   * three, and the tab is exactly the kind of thing a user assumes is
   * remembered.
   */
  const [params, setParams] = useSearchParams();
  const tab = resolveCaseTab(params.get("tab"));
  /**
   * Only the `tab` parameter is rewritten, and the case id is not a parameter
   * at all — it is the path. That is what makes moving between sections
   * incapable of opening a different case: there is nothing in this function
   * that could name one.
   */
  const setTab = (next: CaseTab): void => {
    const merged = new URLSearchParams(params);
    merged.set("tab", next);
    setParams(merged, { replace: false });
  };

  const loanCase = db.cases.find((c) => c.id === caseId);

  if (!loanCase) {
    return <Empty>Case not found.</Empty>;
  }

  // Scope enforcement, the same question RLS will ask.
  const mayRead =
    session.can("case.read", "all") ||
    (session.can("case.read", "own") && loanCase.ownerUserId === session.user.id);

  if (!mayRead) {
    return (
      <Card title="Not your case">
        <p className="text-sm text-ink-700">
          You can only open cases you own, and this one belongs to {ownerName(db, loanCase)}. Ask
          them, or a manager, if you need something from it.
        </p>
        <PermissionCode code="case.read (own)" />
      </Card>
    );
  }

  const applicant = primaryApplicant(db, loanCase.id);
  const progress = progressFor(loanCase.id);

  const counts: Partial<Record<CaseTab, number>> = {
    documents: progress.outstandingCount,
    banks: db.submissions.filter((s) => s.caseId === caseId).length,
  };

  return (
    <div className="space-y-4">
      <CaseHeader caseId={caseId} />

      <div className="flex items-center gap-1 border-b border-ink-200">
        {CASE_TABS.map((entry) => (
          <button
            key={entry}
            onClick={() => setTab(entry)}
            className={cx(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium",
              tab === entry
                ? "border-brand-600 text-ink-900"
                : "border-transparent text-ink-500 hover:text-ink-700",
            )}
          >
            {CASE_TAB_LABELS[entry]}
            {(counts[entry] ?? 0) > 0 && (
              <span
                className="tnum rounded bg-ink-100 px-1.5 text-xs"
                title={
                  entry === "documents"
                    ? `${counts[entry]} still outstanding — not the total number of documents`
                    : undefined
                }
              >
                {counts[entry]}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === "overview" && <Overview caseId={caseId} />}
      {tab === "documents" && <Documents caseId={caseId} />}
      {tab === "banks" && <Banks caseId={caseId} />}
      {tab === "timeline" && <Timeline caseId={caseId} />}

      <CaseSectionFooter caseId={caseId} tab={tab} onGo={setTab} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Save & continue — the path through a case (Part 3)
// ---------------------------------------------------------------------------

/**
 * The draft keys one case owns, named once.
 *
 * The footer has to save the same half-written note the Overview is editing,
 * and two components agreeing on a string by coincidence is how a "Save"
 * button quietly stops saving anything.
 */
function caseDraftKeys(caseId: string): { note: string } {
  return { note: `case:${caseId}:note` };
}

/**
 * The bar at the foot of every section: what is saved, and where to go next.
 *
 * WHAT "SAVE" MEANS HERE, AND WHAT IT DELIBERATELY DOES NOT
 *
 * Every fact on this screen is written through a store mutation the moment it
 * is entered — there is no pending edit buffer anywhere in the case, and there
 * was none before this milestone either. A "Save" button that pretended
 * otherwise would be theatre, and worse, would teach people that the work they
 * did *before* pressing it was at risk.
 *
 * So this bar does two honest things. It SAYS, on every section, that what is
 * on the page is already saved — which is the reassurance the button was being
 * asked for in the first place. And it flushes the one kind of work that
 * genuinely is not part of the case yet: text typed into a box and not
 * submitted, which is kept as a draft (fake/drafts.ts) and would otherwise sit
 * there indefinitely looking saved without being.
 *
 * INCOMPLETE IS SAVEABLE (Part 3). Nothing here is disabled by an outstanding
 * document, and moving on is never refused for one. A telecaller on a first
 * call has almost nothing collected, and that is the normal state of a case
 * rather than an error to block on. The only thing an incomplete file cannot
 * do is reach a stage whose guard the domain layer refuses — which is a
 * different question, asked in the header, with the refusal's own words.
 *
 * NO EVENT IS RECORDED FOR PRESSING THIS (Part 12). Moving between sections is
 * not something that happened to the case. Adding a note is, and that records
 * one — because a note was added, not because a button was pressed.
 */
function CaseSectionFooter({
  caseId,
  tab,
  onGo,
}: {
  caseId: string;
  tab: CaseTab;
  onGo: (tab: CaseTab) => void;
}): ReactNode {
  const session = useSession();
  const toast = useToast();
  const progress = progressFor(caseId);

  const next = nextCaseTab(tab);
  const previous = previousCaseTab(tab);
  const keys = caseDraftKeys(caseId);

  // Documents is the one section whose purpose line spans two different
  // people's jobs — "collect" is the telecaller's and "verify" is Login
  // Desk's. Saying both verbs in one breath, unattributed, reads as if
  // whoever is looking at it is meant to do both (audit finding 13.1).
  const nextPurpose =
    next === "documents" && !session.can("document.verify", "own")
      ? "You collect what those facts require; Login Desk verifies it."
      : next
        ? CASE_TAB_PURPOSE[next]
        : undefined;

  /**
   * Commit whatever this section is holding that is not yet part of the case.
   * Returns what was saved, so the toast can say something true rather than a
   * blanket "Saved".
   */
  const commitSection = (): string[] => {
    const saved: string[] = [];
    if (tab === "overview") {
      const note = getDraft(keys.note).trim();
      if (note && session.can("note.create", "own")) {
        const result = addNote(caseId, note, session.user.id);
        if (result.ok) {
          clearDraft(keys.note);
          saved.push("note");
        } else {
          toast.show(result.message ?? "", "bad");
        }
      }
    }
    return saved;
  };

  const describe = (saved: string[]): string =>
    saved.length === 0
      ? "Nothing was waiting — everything on this page was already saved."
      : `Saved your ${saved.join(" and ")}.`;

  const outstanding = progress.outstandingCount;

  return (
    <div className="rounded-lg bg-white p-4 ring-1 ring-ink-100">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-ink-700">
            {next
              ? `Next: ${CASE_TAB_LABELS[next]} — ${nextPurpose}`
              : "This is the end of the case workflow."}
          </p>
          <p className="mt-0.5 text-xs text-ink-500">
            Everything on this page is saved as you enter it. Nothing is lost by moving on.
            {outstanding > 0 && (
              <>
                {" "}
                {outstanding} document{outstanding === 1 ? "" : "s"} still outstanding — that does
                not stop you saving or continuing.
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {previous && (
            <Button variant="ghost" onClick={() => onGo(previous)}>
              Back to {CASE_TAB_LABELS[previous]}
            </Button>
          )}
          <Button
            onClick={() => {
              const saved = commitSection();
              toast.show(describe(saved));
            }}
          >
            Save draft
          </Button>
          {next && (
            <Button
              variant="primary"
              onClick={() => {
                const saved = commitSection();
                toast.show(describe(saved));
                onGo(next);
              }}
            >
              Save &amp; continue
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header — stage, progress, and the actions the domain layer permits
// ---------------------------------------------------------------------------

function CaseHeader({ caseId }: { caseId: string }): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const toast = useToast();
  const [lostOpen, setLostOpen] = useState(false);
  const [holdOpen, setHoldOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);

  const loanCase = db.cases.find((c) => c.id === caseId);
  if (!loanCase) return null;

  const applicant = primaryApplicant(db, caseId);
  const progress = progressFor(caseId);
  const snapshot = snapshotOf(loanCase);
  const nextActor = waitingOn(
    db,
    loanCase,
    progress,
    db.submissions.filter((s) => s.caseId === caseId),
  );

  /** Which user-driven moves the domain layer will actually accept right now. */
  const offered: CaseStage[] = (
    ["contacted", "appointment_fixed", "documents_pending", "closed"] as CaseStage[]
  ).filter(
    (stage) => evaluateTransition(snapshot, { to: stage, actor: "user" }).allowed,
  );

  const canAct =
    session.can("case.update", "all") ||
    (session.can("case.update", "own") && loanCase.ownerUserId === session.user.id);

  const move = (to: CaseStage): void => {
    const result = moveStage(caseId, to, session.user.id);
    toast.show(result.ok ? `Moved to ${CASE_STAGE_LABELS[to]}` : (result.message ?? ""), result.ok ? "good" : "bad");
  };

  return (
    <>
      <div className="rounded-lg bg-white p-4 ring-1 ring-ink-100">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">
                {applicant ? (
                  <Link to={`/people/${applicant.id}`} className="hover:underline">
                    {applicant.fullName}
                  </Link>
                ) : (
                  "No applicant"
                )}
              </h1>
              <StageBadge stage={loanCase.stage} label={CASE_STAGE_LABELS[loanCase.stage]} />
              {loanCase.isOnHold && (
                <Badge tone="warn">
                  On hold{loanCase.holdUntil ? ` until ${when(loanCase.holdUntil)}` : ""}
                </Badge>
              )}
              {loanCase.tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </div>
            <p className="tnum mt-1 text-sm text-ink-500">
              {loanCase.caseNumber} · {productLabel(db, loanCase)} ·{" "}
              {money(loanCase.requestedAmount)}
            </p>
            {/* "Owner" used to mean two different things at once — who
                brought the case in, and who currently has it. Split so
                management can actually answer "which telecaller sourced
                this?" without it being confused with "who's holding it now?"
                (Part 4). */}
            <p className="mt-0.5 text-xs text-ink-500">
              Originated by {originatorName(db, loanCase)} · Currently with{" "}
              {ownerName(db, loanCase)}
              {" · "}
              {CASE_STAGE_LABELS[loanCase.stage]} since {when(enteredCurrentStageAt(db, loanCase))}
            </p>
            {nextActor && (
              // Distinct from "Currently with" above: that is who holds the
              // case, this is whose turn it is to act — not always the same
              // person once a document has moved into someone else's queue.
              <p className="mt-1 text-xs font-medium text-sky-700">{nextActor.summary}</p>
            )}
            {loanCase.stage === "lost" && (
              <p className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-900">
                Lost: {LOST_REASON_LABELS[loanCase.lostReason as LostReason]}
                {loanCase.lostNote && ` — ${loanCase.lostNote}`}
                {loanCase.stageBeforeLost && (
                  <span className="mt-0.5 block text-xs">
                    Was at {CASE_STAGE_LABELS[loanCase.stageBeforeLost]}. Reopening returns it
                    there.
                  </span>
                )}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canAct &&
              offered.map((stage) => (
                <Button key={stage} onClick={() => move(stage)}>
                  {stage === "closed" ? "Close case" : `Move to ${CASE_STAGE_LABELS[stage]}`}
                </Button>
              ))}

            {canAct && loanCase.stage === "lost" && loanCase.stageBeforeLost && (
              <Button onClick={() => move(loanCase.stageBeforeLost as CaseStage)}>
                Reopen to {CASE_STAGE_LABELS[loanCase.stageBeforeLost]}
              </Button>
            )}

            {session.can("case.hold", "own") &&
              loanCase.stage !== "lost" &&
              loanCase.stage !== "closed" &&
              (loanCase.isOnHold ? (
                <Button
                  onClick={() => {
                    setHold(caseId, false, session.user.id);
                    toast.show("Hold lifted");
                  }}
                >
                  Lift hold
                </Button>
              ) : (
                <Button onClick={() => setHoldOpen(true)}>Hold</Button>
              ))}

            {session.can("case.mark_lost", "own") &&
              loanCase.stage !== "lost" &&
              loanCase.stage !== "closed" && (
                <Button variant="danger" onClick={() => setLostOpen(true)}>
                  Mark lost
                </Button>
              )}

            {/* Who currently holds the case, changeable — the manager-only
                move that makes "who processed it in Login" answerable at all
                (Part 4). Reuses the existing assignOwner, wired in for the
                first time. */}
            {session.can("case.assign", "all") && (
              <Button variant="ghost" onClick={() => setReassignOpen(true)}>
                Reassign
              </Button>
            )}
          </div>
        </div>

        <div className="mt-4 grid gap-4 border-t border-ink-100 pt-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-xs font-medium text-ink-700">Document completeness</span>
              <span className="text-xs text-ink-500">
                {progress.applicableCount === 0
                  ? "Nothing applicable yet"
                  : `${progress.verifiedCount} of ${progress.applicableCount} verified`}
                {progress.waivedCount > 0 && ` · ${progress.waivedCount} waived`}
                {progress.upcomingCount > 0 && ` · ${progress.upcomingCount} not due yet`}
              </span>
            </div>
            <ProgressBar
              percent={progress.percentComplete}
              applicable={progress.applicableCount}
            />
            {progress.applicableCount === 0 && (
              <p className="mt-1.5 text-xs text-ink-500">
                Nothing is missing from this case. A case with no applicable requirements is
                complete, not zero.
              </p>
            )}
          </div>
          <div>
            <span className="block text-xs font-medium text-ink-700">Contact</span>
            <span className="tnum block text-sm">{primaryPhone(applicant) ?? "No number"}</span>
          </div>
        </div>
      </div>

      <MarkLostDialog
        open={lostOpen}
        caseId={caseId}
        onClose={() => setLostOpen(false)}
      />
      <HoldDialog open={holdOpen} caseId={caseId} onClose={() => setHoldOpen(false)} />
      <ReassignDialog open={reassignOpen} caseId={caseId} onClose={() => setReassignOpen(false)} />
    </>
  );
}

/**
 * Hand the case to someone else — the manager-only move behind "Reassign"
 * (Part 4). Writes through the already-existing `assignOwner`; this dialog
 * is the first thing that ever calls it.
 */
function ReassignDialog({
  open,
  caseId,
  onClose,
}: {
  open: boolean;
  caseId: string;
  onClose: () => void;
}): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const toast = useToast();
  const loanCase = db.cases.find((c) => c.id === caseId);
  const [ownerUserId, setOwnerUserId] = useState("");

  useEffect(() => {
    if (open && loanCase) setOwnerUserId(loanCase.ownerUserId);
  }, [open, loanCase]);

  if (!loanCase) return null;

  return (
    <Modal open={open} title="Reassign this case" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-ink-700">
          Changes who is currently responsible. It does not change who originated the case — that
          stays on the record permanently.
        </p>
        <Field label="New owner">
          <Select value={ownerUserId} onChange={(event) => setOwnerUserId(event.target.value)}>
            {db.users
              .filter((user) => user.isActive)
              .map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
          </Select>
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Back
          </Button>
          <Button
            variant="primary"
            disabled={!ownerUserId}
            onClick={() => {
              const result = assignOwner(caseId, ownerUserId, session.user.id);
              toast.show(result.ok ? "Reassigned" : (result.message ?? ""), result.ok ? "good" : "bad");
              if (result.ok) onClose();
            }}
          >
            Confirm reassignment
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function MarkLostDialog({
  open,
  caseId,
  onClose,
}: {
  open: boolean;
  caseId: string;
  onClose: () => void;
}): ReactNode {
  const session = useSession();
  const toast = useToast();
  const [reason, setReason] = useState<LostReason>("not_interested");
  const [note, setNote] = useState("");

  return (
    <Modal open={open} title="Mark this case lost" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-ink-700">
          A reason is required and comes from a controlled list. Lost cases are the most
          instructive data the company accumulates, and free text alone cannot be analysed.
        </p>
        <Field label="Reason">
          <Select value={reason} onChange={(event) => setReason(event.target.value as LostReason)}>
            {LOST_REASONS.map((value) => (
              <option key={value} value={value}>
                {LOST_REASON_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Note" hint="Optional. Accompanies the reason, never replaces it.">
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => {
              const result = moveStage(caseId, "lost", session.user.id, reason, note);
              toast.show(result.ok ? "Case marked lost" : (result.message ?? ""), result.ok ? "good" : "bad");
              if (result.ok) onClose();
            }}
          >
            Mark lost
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function HoldDialog({
  open,
  caseId,
  onClose,
}: {
  open: boolean;
  caseId: string;
  onClose: () => void;
}): ReactNode {
  const session = useSession();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");

  return (
    <Modal open={open} title="Put this case on hold" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-ink-700">
          A hold is not a stage. The case stays where it is, and it drops out of "needs attention"
          until the follow-up date — so it stops generating noise without being forgotten.
        </p>
        <Field label="Reason">
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Customer travelling until month end"
          />
        </Field>
        <Field label="Follow up on">
          <Input type="date" value={until} onChange={(event) => setUntil(event.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              const result = setHold(caseId, true, session.user.id, reason, until || undefined);
              toast.show(result.ok ? "Case held" : (result.message ?? ""), result.ok ? "good" : "bad");
              if (result.ok) onClose();
            }}
          >
            Hold
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Overview — parties, property, notes, communications
// ---------------------------------------------------------------------------

function Overview({ caseId }: { caseId: string }): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const toast = useToast();
  const [addOpen, setAddOpen] = useState(false);
  // Persisted: switching to Documents and back must not eat a half-written
  // note (Part 7).
  const [note, setNote] = useDraft(caseDraftKeys(caseId).note);
  const [logOpen, setLogOpen] = useState(false);
  const [profileFor, setProfileFor] = useState<string | null>(null);
  const [propertyFor, setPropertyFor] = useState<string | null>(null);
  const [addPropertyOpen, setAddPropertyOpen] = useState(false);
  const [editOrganisationFor, setEditOrganisationFor] = useState<string | null>(null);

  const parties = db.caseParties.filter((p) => p.caseId === caseId && !p.removedAt);
  const caseProperties = db.caseProperties.filter((p) => p.caseId === caseId);
  const notes = db.notes.filter((n) => n.caseId === caseId);
  const communications = db.communications
    .filter((c) => c.caseId === caseId)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  const canEdit =
    session.can("case.update", "all") ||
    (session.can("case.update", "own") &&
      db.cases.find((c) => c.id === caseId)?.ownerUserId === session.user.id);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        {/* Every fact the document rules read, on the page that shows them,
            each one with an input behind it (Part 5). Before this milestone
            the Overview listed facts a user could read and not change, which
            is the most frustrating possible state for a screen to be in. */}
        <CaseFacts caseId={caseId} />

        <ExistingObligations caseId={caseId} />

        <Card
          title="People on this case"
          subtitle="Only the primary applicant is mandatory — everything else exists because reality supplied it"
          actions={
            canEdit && <Button onClick={() => setAddOpen(true)}>Add someone</Button>
          }
        >
          <ul className="divide-y divide-ink-100">
            {parties.map((party) => {
              const person = db.people.find((p) => p.id === party.personId);
              const organisation = db.organisations.find((o) => o.id === party.organisationId);
              const employment = db.employments.find(
                (e) => e.personId === party.personId && e.isCurrent,
              );
              const employer = db.organisations.find((o) => o.id === employment?.organisationId);

              // Occupation and business type as the DOCUMENT RULES read them
              // (Part 5): the case-party override first, the shared person or
              // organisation record behind it. Shown because they change the
              // checklist, and shown with "Not set" spelled out rather than a
              // dash, because a telecaller needs to know there is a question
              // still to ask.
              const occupation =
                db.employmentTypes.find((t) => t.id === party.employmentTypeId)?.name ??
                (employment ? titleCase(employment.employmentType) : undefined);
              const businessType = db.businessConstitutions.find(
                (t) =>
                  t.id ===
                  (party.businessConstitutionId ?? organisation?.businessConstitutionId),
              )?.name;
              const borrowerType = db.borrowerTypes.find((t) => t.id === party.borrowerTypeId)?.name;

              return (
                <li key={party.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {person ? (
                        <Link
                          to={`/people/${person.id}`}
                          className="text-sm font-medium hover:underline"
                        >
                          {person.fullName}
                        </Link>
                      ) : (
                        <span className="text-sm font-medium">{organisation?.canonicalName}</span>
                      )}
                      <Badge tone={party.isPrimary ? "info" : "neutral"}>
                        {titleCase(party.role)}
                      </Badge>
                    </div>
                    <p className="text-xs text-ink-500">
                      {person && primaryPhone(person)}
                      {employment && employer && (
                        <>
                          {" · "}
                          {employment.designation} at {employer.canonicalName}
                          {employment.monthlyIncome && ` · ${money(employment.monthlyIncome)}/mo`}
                        </>
                      )}
                    </p>
                    {party.role !== "referrer" && (
                      <p className="mt-0.5 text-xs text-ink-500">
                        {person && (
                          <>
                            Occupation:{" "}
                            <span className={occupation ? "text-ink-700" : "text-amber-700"}>
                              {occupation ?? "Not set"}
                            </span>
                          </>
                        )}
                        {(organisation || businessType) && (
                          <>
                            {person ? " · " : ""}Business type:{" "}
                            <span className={businessType ? "text-ink-700" : "text-amber-700"}>
                              {businessType ?? "Not set"}
                            </span>
                          </>
                        )}
                        {borrowerType && ` · ${borrowerType}`}
                      </p>
                    )}
                  </div>
                  {person && (
                    <span className="tnum shrink-0 text-xs text-ink-500">
                      {/* Column-level masking, standing in for what ADR-026 does
                          in the database. */}
                      {session.can("identifier.view_full", "all")
                        ? (panOf(person) ?? "")
                        : (maskedPan(person) ?? "")}
                    </span>
                  )}
                  {/* The business's own record — name, address, GST/Udyam
                      (Part 3). Distinct from "Profile" below: this edits the
                      shared organisation, not this case's view of it. */}
                  {organisation && session.can("organisation.update", "all") && (
                    <Button variant="ghost" onClick={() => setEditOrganisationFor(organisation.id)}>
                      Edit business
                    </Button>
                  )}
                  {/* How this party is underwritten ON THIS CASE — the facts
                      the Document Requirement Engine reads (Milestone 9). */}
                  {canEdit && party.role !== "referrer" && (
                    <Button variant="ghost" onClick={() => setProfileFor(party.id)}>
                      Profile
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>

        {/* No empty section for a property that does not exist. Absence is
            silence (Principle #1) — but the way to CREATE one has to be
            reachable, so the card appears with an empty state once a user may
            edit the case (Part 5). */}
        {(caseProperties.length > 0 || canEdit) && (
          <Card
            title="Property"
            subtitle="Property documents exist only because a property does — Patta, Chitta, EC and the rest appear the moment one is added, and stop being asked for the moment it is removed"
            actions={canEdit && <Button onClick={() => setAddPropertyOpen(true)}>Add property</Button>}
          >
            {caseProperties.length === 0 ? (
              <Empty>
                No property on this case, so no property documents are being asked for.
              </Empty>
            ) : (
              <ul className="divide-y divide-ink-100">
                {caseProperties.map((link) => {
                  const property = db.properties.find((p) => p.id === link.propertyId);
                  return (
                    <li key={link.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">
                          {[property?.buildingName, property?.doorNumber]
                            .filter(Boolean)
                            .join(" ") || property?.locality || "Property"}
                        </p>
                        <p className="text-xs text-ink-500">
                          {[property?.locality, property?.city].filter(Boolean).join(", ")}
                          {" · "}
                          <span className={property?.propertyType ? "" : "text-amber-700"}>
                            {property?.propertyType ?? "Type not set"}
                          </span>
                          {property?.estimatedValue ? ` · ${lakhs(property.estimatedValue)}` : ""}
                          {" · "}
                          {titleCase(link.role)}
                        </p>
                      </div>
                      {canEdit && (
                        <Button variant="ghost" onClick={() => setPropertyFor(link.id)}>
                          Edit
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        )}

        <Card
          title="Conversations"
          subtitle="Logged against both the person and the case"
          actions={
            session.can("communication.log", "own") && (
              <Button onClick={() => setLogOpen(true)}>Log a call</Button>
            )
          }
        >
          {communications.length === 0 ? (
            <Empty>Nothing logged yet.</Empty>
          ) : (
            <ul className="divide-y divide-ink-100">
              {communications.map((communication) => (
                <li key={communication.id} className="py-2.5 first:pt-0 last:pb-0">
                  <div className="flex items-center gap-2">
                    <Badge tone={communication.direction === "inbound" ? "good" : "neutral"}>
                      {communication.channel}
                    </Badge>
                    <span className="text-sm font-medium">{communication.subject}</span>
                    <span className="ml-auto text-xs text-ink-500">
                      {when(communication.occurredAt)}
                    </span>
                  </div>
                  {communication.body && (
                    <p className="mt-1 text-sm text-ink-700">{communication.body}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="space-y-6">
        <Card title="Notes" subtitle="Internal. Not a place for structured facts.">
          {session.can("note.read", "own") ? (
            <>
              {notes.length === 0 ? (
                <Empty>No notes.</Empty>
              ) : (
                <ul className="space-y-3">
                  {notes.map((entry) => (
                    <li key={entry.id}>
                      <p className="text-sm text-ink-700">{entry.body}</p>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {db.users.find((u) => u.id === entry.authorId)?.name} ·{" "}
                        {when(entry.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              {session.can("note.create", "own") && (
                <div className="mt-3 border-t border-ink-100 pt-3">
                  <Textarea
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="What would you want to know in three weeks?"
                  />
                  <Button
                    className="mt-2"
                    onClick={() => {
                      const result = addNote(caseId, note, session.user.id);
                      if (result.ok) setNote("");
                      else toast.show(result.message ?? "", "bad");
                    }}
                  >
                    Add note
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div>
              <p className="text-sm text-ink-500">You don't have access to this case's notes.</p>
              <PermissionCode code="note.read" />
            </div>
          )}
        </Card>
      </div>

      <AddPartyDialog open={addOpen} caseId={caseId} onClose={() => setAddOpen(false)} />
      <LogCallDialog open={logOpen} caseId={caseId} onClose={() => setLogOpen(false)} />
      <PartyProfileDialog casePartyId={profileFor} onClose={() => setProfileFor(null)} />
      <AddPropertyDialog
        open={addPropertyOpen}
        caseId={caseId}
        onClose={() => setAddPropertyOpen(false)}
      />
      <EditPropertyDialog casePropertyId={propertyFor} onClose={() => setPropertyFor(null)} />
      <EditOrganisationDialog
        organisationId={editOrganisationFor}
        onClose={() => setEditOrganisationFor(null)}
      />
    </div>
  );
}

/**
 * Correct or remove a property already on the case (Part 5).
 *
 * The property TYPE is the point of this dialog: it decides whether Patta &
 * Chitta is asked for (an apartment on undivided share has none of its own)
 * and whether layout approval is. Before this existed the type could be set
 * once, wrongly, at creation and never corrected — and the only way out was
 * to abandon the case.
 */
function EditPropertyDialog({
  casePropertyId,
  onClose,
}: {
  casePropertyId: string | null;
  onClose: () => void;
}): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const toast = useToast();

  const link = db.caseProperties.find((p) => p.id === casePropertyId);
  const property = db.properties.find((p) => p.id === link?.propertyId);

  const [locality, setLocality] = useState("");
  const [city, setCity] = useState("");
  const [typeId, setTypeId] = useState("");
  const [role, setRole] = useState<"collateral" | "purchase" | "both">("collateral");
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);

  useEffect(() => {
    if (!link || !property) return;
    setLocality(property.locality ?? "");
    setCity(property.city ?? "");
    setTypeId(property.propertyTypeId ?? "");
    setRole(link.role);
    setConfirmingRemoval(false);
  }, [link, property]);

  if (!link || !property) return null;

  return (
    <Modal open={casePropertyId !== null} title="Property on this case" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Locality">
          <Input value={locality} onChange={(event) => setLocality(event.target.value)} />
        </Field>
        <Field label="City">
          <Input value={city} onChange={(event) => setCity(event.target.value)} />
        </Field>
        <Field
          label="Property type"
          hint="Changes the checklist: an apartment on undivided share has no Patta of its own, and a plot needs DTCP or CMDA layout approval."
        >
          <Select value={typeId} onChange={(event) => setTypeId(event.target.value)}>
            <option value="">Not set</option>
            {db.propertyTypes
              .filter((type) => type.isActive)
              .map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Role on this case">
          <Select value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
            <option value="collateral">Collateral</option>
            <option value="purchase">Purchase</option>
            <option value="both">Both</option>
          </Select>
        </Field>

        {confirmingRemoval && (
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Removing this property stops every property document being asked for. Nothing already
            collected is deleted — those requirements become "no longer applicable" and stay in the
            case's history.
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Back
          </Button>
          {confirmingRemoval ? (
            <Button
              variant="danger"
              onClick={() => {
                const result = removeCaseProperty(link.id, session.user.id);
                toast.show(
                  result.ok ? "Property removed. Its documents are no longer applicable." : (result.message ?? ""),
                  result.ok ? "good" : "bad",
                );
                if (result.ok) onClose();
              }}
            >
              Confirm removal
            </Button>
          ) : (
            <Button variant="danger" onClick={() => setConfirmingRemoval(true)}>
              Remove from case
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => {
              const result = updateCaseProperty(
                link.id,
                { role, locality, city, ...(typeId ? { propertyTypeId: typeId } : {}) },
                session.user.id,
              );
              toast.show(
                result.ok ? "Saved. The documents list has already changed." : (result.message ?? ""),
                result.ok ? "good" : "bad",
              );
              if (result.ok) onClose();
            }}
          >
            Save &amp; continue
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * How one party is underwritten on this case.
 *
 * Deliberately NOT an edit of the person's employment record or the
 * organisation's constitution. Rewriting a shared entity from a case screen
 * would corrupt every other case that person is on, and "salaried on this
 * file, business owner on that one" is two facts rather than one fact that
 * keeps changing (Database/migrations/0021).
 */
function PartyProfileDialog({
  casePartyId,
  onClose,
}: {
  casePartyId: string | null;
  onClose: () => void;
}): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const toast = useToast();

  const party = db.caseParties.find((p) => p.id === casePartyId);
  const [employmentTypeId, setEmploymentTypeId] = useState("");
  const [borrowerTypeId, setBorrowerTypeId] = useState("");
  const [constitutionId, setConstitutionId] = useState("");

  useEffect(() => {
    if (!party) return;
    setEmploymentTypeId(party.employmentTypeId ?? "");
    setBorrowerTypeId(party.borrowerTypeId ?? "");
    setConstitutionId(party.businessConstitutionId ?? "");
  }, [party]);

  if (!party) return null;

  const isOrganisation = Boolean(party.organisationId);
  const person = db.people.find((p) => p.id === party.personId);
  const organisation = db.organisations.find((o) => o.id === party.organisationId);

  return (
    <Modal
      open={casePartyId !== null}
      title={`${person?.fullName ?? organisation?.canonicalName ?? "Party"} — on this case`}
      onClose={onClose}
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-700">
          These answers decide what this party is asked for. They apply to this case only — the
          person's own record is not rewritten.
        </p>

        {!isOrganisation && (
          <Field
            label="Employment type"
            hint="Salaried is asked for payslips and Form 16; self-employed for an ITR. Leaving it blank uses the person's current employment record."
          >
            <Select
              value={employmentTypeId}
              onChange={(event) => setEmploymentTypeId(event.target.value)}
            >
              <option value="">Use the person's employment record</option>
              {db.employmentTypes
                .filter((type) => type.isActive)
                .map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
            </Select>
          </Field>
        )}

        <Field
          label="Borrower type"
          hint="NRI is the one that must be recorded explicitly — nothing about a person implies it, and it changes the whole KYC set."
        >
          <Select
            value={borrowerTypeId}
            onChange={(event) => setBorrowerTypeId(event.target.value)}
          >
            <option value="">
              {isOrganisation ? "Non-individual entity" : "Resident individual"}
            </option>
            {db.borrowerTypes
              .filter((type) => type.isActive)
              .map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
          </Select>
        </Field>

        {isOrganisation && (
          <Field
            label="Business constitution"
            hint="A partnership is asked for its deed; a private limited for incorporation, MOA/AOA and a board resolution. This one answer changes most of the business checklist."
          >
            <Select
              value={constitutionId}
              onChange={(event) => setConstitutionId(event.target.value)}
            >
              <option value="">Use the organisation's own record</option>
              {db.businessConstitutions
                .filter((type) => type.isActive)
                .map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
            </Select>
          </Field>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Back
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const result = updatePartyProfile(
                party.id,
                {
                  ...(employmentTypeId ? { employmentTypeId } : {}),
                  ...(borrowerTypeId ? { borrowerTypeId } : {}),
                  ...(constitutionId ? { businessConstitutionId: constitutionId } : {}),
                },
                session.user.id,
              );
              if (!result.ok) {
                toast.show(result.message ?? "", "bad");
                return;
              }
              toast.show("Saved. The documents list has already changed.");
              onClose();
            }}
          >
            Save &amp; continue
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Correct a business's own record — name, address, and its GST/Udyam
 * registration as the business reports it (Part 3).
 *
 * NOT the same thing as "Profile" above. `PartyProfileDialog` records how
 * THIS CASE underwrites the organisation and never touches the shared row;
 * this dialog writes through `updateOrganisation` and changes what every
 * case involving this organisation shows. The GST/Udyam fields here are
 * explicitly the business's OWN record, kept apart from the case-level GST
 * question on "What this case is" above — the two are allowed to disagree,
 * and this dialog says so rather than quietly overwriting one with the
 * other.
 */
function EditOrganisationDialog({
  organisationId,
  onClose,
}: {
  organisationId: string | null;
  onClose: () => void;
}): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const toast = useToast();

  const organisation = db.organisations.find((o) => o.id === organisationId);

  const [canonicalName, setCanonicalName] = useState("");
  const [industry, setIndustry] = useState("");
  const [city, setCity] = useState("");
  const [addressLine, setAddressLine] = useState("");
  const [locality, setLocality] = useState("");
  const [pincode, setPincode] = useState("");
  const [district, setDistrict] = useState("");
  const [state, setState] = useState("");
  const [constitutionId, setConstitutionId] = useState("");
  const [gstRegistered, setGstRegistered] = useState("");
  const [gstin, setGstin] = useState("");
  const [udyamRegistered, setUdyamRegistered] = useState("");
  const [udyamNumber, setUdyamNumber] = useState("");

  useEffect(() => {
    if (!organisation) return;
    setCanonicalName(organisation.canonicalName);
    setIndustry(organisation.industry ?? "");
    setCity(organisation.city ?? "");
    setAddressLine(organisation.addressLine ?? "");
    setLocality(organisation.locality ?? "");
    setPincode(organisation.pincode ?? "");
    setDistrict(organisation.district ?? "");
    setState(organisation.state ?? "");
    setConstitutionId(organisation.businessConstitutionId ?? "");
    setGstRegistered(
      organisation.isGstRegistered === undefined ? "" : String(organisation.isGstRegistered),
    );
    setGstin(organisation.gstin ?? "");
    setUdyamRegistered(
      organisation.udyamRegistered === undefined ? "" : String(organisation.udyamRegistered),
    );
    setUdyamNumber(organisation.udyamNumber ?? "");
  }, [organisation]);

  if (!organisation) return null;

  const parseTri = (value: string): boolean | undefined =>
    value === "" ? undefined : value === "true";

  const save = (): void => {
    const result = updateOrganisation(
      organisation.id,
      {
        canonicalName,
        industry,
        city,
        addressLine,
        locality,
        pincode,
        district,
        state,
        ...(constitutionId ? { businessConstitutionId: constitutionId } : {}),
        isGstRegistered: parseTri(gstRegistered),
        gstin,
        udyamRegistered: parseTri(udyamRegistered),
        udyamNumber,
      },
      session.user.id,
    );
    if (!result.ok) {
      toast.show(result.message ?? "", "bad");
      return;
    }
    toast.show("Saved.");
    onClose();
  };

  return (
    <Modal open={organisationId !== null} title={`Edit ${organisation.canonicalName}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Business name">
          <Input value={canonicalName} onChange={(event) => setCanonicalName(event.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Industry">
            <Input value={industry} onChange={(event) => setIndustry(event.target.value)} />
          </Field>
          <Field label="Constitution">
            <Select value={constitutionId} onChange={(event) => setConstitutionId(event.target.value)}>
              <option value="">—</option>
              {db.businessConstitutions
                .filter((type) => type.isActive)
                .map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>

        <Field label="Address">
          <Input
            value={addressLine}
            onChange={(event) => setAddressLine(event.target.value)}
            placeholder="14 Mettupalayam Road"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Locality">
            <Input value={locality} onChange={(event) => setLocality(event.target.value)} />
          </Field>
          <Field label="City">
            <Input value={city} onChange={(event) => setCity(event.target.value)} />
          </Field>
          <Field label="District">
            <Input value={district} onChange={(event) => setDistrict(event.target.value)} />
          </Field>
          <Field label="State">
            <Input value={state} onChange={(event) => setState(event.target.value)} />
          </Field>
          <Field label="PIN code">
            <Input value={pincode} onChange={(event) => setPincode(event.target.value)} />
          </Field>
        </div>

        <div className="border-t border-ink-100 pt-3">
          <p className="text-xs font-medium text-ink-700">GST &amp; Udyam — on this business's record</p>
          <p className="mt-0.5 text-xs text-ink-500">
            This is the business's own record, not this case's answer — see the GST question under
            "What this case is" above. The two are allowed to differ.
          </p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Field label="GST registered?">
              <Select value={gstRegistered} onChange={(event) => setGstRegistered(event.target.value)}>
                <option value="">Not recorded</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            </Field>
            <Field label="GSTIN">
              <Input value={gstin} onChange={(event) => setGstin(event.target.value)} />
            </Field>
            <Field label="Udyam registered?">
              <Select
                value={udyamRegistered}
                onChange={(event) => setUdyamRegistered(event.target.value)}
              >
                <option value="">Not recorded</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            </Field>
            <Field label="Udyam number">
              <Input value={udyamNumber} onChange={(event) => setUdyamNumber(event.target.value)} />
            </Field>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Back
          </Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AddPartyDialog({
  open,
  caseId,
  onClose,
}: {
  open: boolean;
  caseId: string;
  onClose: () => void;
}): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const toast = useToast();
  const [role, setRole] = useState<CasePartyRole>("co_applicant");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [chosenPersonId, setChosenPersonId] = useState<Id | null>(null);
  const [chosenOrganisationId, setChosenOrganisationId] = useState<Id | null>(null);

  const isFirm = role === "borrower_firm";

  const reset = (): void => {
    setName("");
    setPhone("");
    setChosenPersonId(null);
    setChosenOrganisationId(null);
  };

  const ready = isFirm
    ? chosenOrganisationId !== null || name.trim().length > 1
    : chosenPersonId !== null || name.trim().length > 1;

  return (
    <Modal
      open={open}
      title="Add someone to this case"
      onClose={() => {
        reset();
        onClose();
      }}
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-700">
          Adding a co-applicant generates their requirements immediately, and progress will move
          backwards. That is correct and it is shown in the timeline — an honest number that moves
          is more useful than a flattering one that does not.
        </p>
        <Field label="Role">
          <Select
            value={role}
            onChange={(event) => {
              setRole(event.target.value as CasePartyRole);
              reset();
            }}
          >
            <option value="co_applicant">Co-applicant</option>
            <option value="guarantor">Guarantor</option>
            <option value="referrer">Referrer</option>
            <option value="borrower_firm">Borrowing firm</option>
          </Select>
        </Field>

        {isFirm ? (
          <OrganisationSearchField
            db={db}
            name={name}
            chosenOrganisationId={chosenOrganisationId}
            onNameChange={setName}
            onChoose={setChosenOrganisationId}
          />
        ) : (
          <PersonSearchField
            db={db}
            name={name}
            phone={phone}
            chosenPersonId={chosenPersonId}
            onNameChange={setName}
            onPhoneChange={setPhone}
            onChoose={setChosenPersonId}
          />
        )}

        <div className="flex justify-end gap-2">
          <Button
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() => {
              addParty(
                caseId,
                role,
                isFirm
                  ? chosenOrganisationId
                    ? { organisationId: chosenOrganisationId }
                    : { newOrganisationName: name.trim() }
                  : chosenPersonId
                    ? { personId: chosenPersonId }
                    : { newPersonName: name.trim(), newPersonPhone: phone.trim() },
                session.user.id,
              );
              toast.show("Added. Requirements regenerated.");
              reset();
              onClose();
            }}
          >
            Add
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function LogCallDialog({
  open,
  caseId,
  onClose,
}: {
  open: boolean;
  caseId: string;
  onClose: () => void;
}): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const toast = useToast();
  const applicant = primaryApplicant(db, caseId);
  const [channel, setChannel] = useState<"call" | "whatsapp" | "email" | "sms" | "meeting">("call");
  const [direction, setDirection] = useState<"inbound" | "outbound">("outbound");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  return (
    <Modal open={open} title="Log a conversation" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Channel">
            <Select value={channel} onChange={(event) => setChannel(event.target.value as typeof channel)}>
              <option value="call">Call</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="email">Email</option>
              <option value="sms">SMS</option>
              <option value="meeting">Meeting</option>
            </Select>
          </Field>
          <Field label="Direction">
            <Select
              value={direction}
              onChange={(event) => setDirection(event.target.value as typeof direction)}
            >
              <option value="outbound">We contacted them</option>
              <option value="inbound">They contacted us</option>
            </Select>
          </Field>
        </div>
        <Field label="Subject">
          <Input value={subject} onChange={(event) => setSubject(event.target.value)} />
        </Field>
        <Field label="What was said">
          <Textarea value={body} onChange={(event) => setBody(event.target.value)} />
        </Field>
        <p className="text-xs text-ink-500">
          On a case at <em>New</em>, logging the first conversation moves it to <em>Contacted</em>.
          That trigger is in the workflow, not in this screen.
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!applicant}
            onClick={() => {
              if (!applicant) return;
              logCommunication(
                caseId,
                applicant.id,
                channel,
                direction,
                subject,
                body,
                session.user.id,
              );
              toast.show("Logged");
              onClose();
            }}
          >
            Log
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Documents — the login desk's one question
// ---------------------------------------------------------------------------

function Documents({ caseId }: { caseId: string }): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
  const [waiveFor, setWaiveFor] = useState<string | null>(null);
  // Persisted: a waiver reason is the kind of sentence people compose slowly,
  // and losing it to an accidental tab change is exactly the frustration
  // Part 7 is about.
  const [waiveReason, setWaiveReason] = useDraft(`case:${caseId}:waive-reason`);
  const [addingYearFor, setAddingYearFor] = useState<FyGroup | null>(null);
  const [verifyFor, setVerifyFor] = useState<string | null>(null);
  const [viewFor, setViewFor] = useState<string | null>(null);
  const [addCustomOpen, setAddCustomOpen] = useState(false);
  const [removeCustomFor, setRemoveCustomFor] = useState<string | null>(null);
  // Replace/Remove milestone: replacing asks for the new file straight away
  // (same file-picker flow as Upload, just gated open by a confirmation
  // first, since it supersedes an already-received/verified document).
  // Removing has no file to pick, so it is its own confirm-and-act dialog.
  const [replaceFor, setReplaceFor] = useState<string | null>(null);
  const [removeUploadFor, setRemoveUploadFor] = useState<string | null>(null);

  if (!session.can("document.read", "own")) {
    return (
      <Card title="Documents are not visible to this user">
        <p className="text-sm text-ink-700">You don't have access to this case's documents.</p>
        <PermissionCode code="document.read" />
      </Card>
    );
  }

  const loanCase = db.cases.find((c) => c.id === caseId);
  const requirements = db.requirements.filter((r) => r.caseId === caseId);
  const progress = progressFor(caseId);

  const stageOrder = [
    "new",
    "contacted",
    "appointment_fixed",
    "documents_pending",
    "ready_for_submission",
    "submitted",
    "sanctioned",
    "disbursed",
  ];
  const currentIndex = stageOrder.indexOf(loanCase?.stage ?? "new");

  const due = requirements.filter(
    (r) => currentIndex >= 0 && stageOrder.indexOf(r.applicableFromStage) <= currentIndex,
  );
  const upcoming = requirements.filter(
    (r) => currentIndex >= 0 && stageOrder.indexOf(r.applicableFromStage) > currentIndex,
  );

  const outstanding = due.filter((r) =>
    ["pending", "received", "rejected"].includes(r.status),
  );
  const settled = due.filter((r) => ["verified", "waived", "not_applicable"].includes(r.status));
  const fyGroups = financialYearGroups(db, requirements);

  const onFileChosen = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    const requirementId = uploadingFor;
    setUploadingFor(null);
    event.target.value = "";
    if (!file || !requirementId) return;

    void file
      .arrayBuffer()
      .then((buffer) =>
        uploadDocument(
          requirementId,
          {
            name: file.name,
            size: file.size,
            bytes: new Uint8Array(buffer),
            ...(file.type ? { contentType: file.type } : {}),
          },
          session.user.id,
        ),
      )
      .then((result) => {
        if (result.ok) {
          toast.show(`${file.name} uploaded. It still needs a human to verify it.`);
        } else {
          toast.show(result.message ?? "Upload failed.", "bad");
        }
      })
      // storageAdapter.put talks to a real local server (Backend/storage-server.mjs)
      // and rejects rather than returning ok:false when it cannot be reached at
      // all — a dropped connection is a thrown error, not a business refusal. Both
      // must reach the user: an upload that silently does nothing teaches nobody
      // that anything went wrong (Part 2).
      .catch((error: unknown) => {
        toast.show(error instanceof Error ? error.message : "Upload failed.", "bad");
      });
  };

  /**
   * How one requirement presents itself: what we call it to the customer,
   * what it is called locally, the one-line explanation, and which block of
   * the checklist it belongs in (Parts 8 and 9).
   *
   * A hand-added requirement carries its own answers to all four (Part 6);
   * everything else reads them from the document type, which is master data
   * and editable.
   */
  const presentationOf = (
    requirement: (typeof requirements)[number],
  ): {
    name: string;
    localName?: string | undefined;
    description?: string | undefined;
    examples?: readonly string[] | undefined;
    category: DocumentCategory;
  } => {
    const type = db.documentTypes.find((t) => t.id === requirement.documentTypeId);
    if (requirement.isCustom) {
      return {
        name: requirement.customName ?? type?.name ?? "Document",
        description: requirement.customDescription,
        category: requirement.customCategory ?? "additional",
      };
    }
    // The PERIOD IS PART OF THE NAME, not a suffix beside it. Two years of GST
    // returns rendered as two rows both called "GST 3B" reads as the same
    // document asked for twice, and a checklist that looks buggy is a
    // checklist people stop trusting. "GST 3B – FY 2025-26" and
    // "GST 3B – FY 2024-25" are visibly two different asks.
    const label = requirement.periodStart
      ? financialYearOf(new Date(requirement.periodStart)).label
      : undefined;
    return {
      name: documentRowLabel(type?.name ?? "Document", label, type?.periodKind),
      localName: type?.localName,
      description: type?.description,
      examples: type?.examples,
      category: type?.category ?? "additional",
    };
  };

  /** Group a list of requirements into the six blocks, dropping empty ones. */
  const byCategory = (
    rows: typeof requirements,
  ): Array<{ category: DocumentCategory; rows: typeof requirements }> =>
    DOCUMENT_CATEGORIES.map((category) => ({
      category,
      rows: rows.filter((row) => presentationOf(row).category === category),
    })).filter((group) => group.rows.length > 0);

  const Row = ({ requirementId }: { requirementId: string }): ReactNode => {
    const requirement = requirements.find((r) => r.id === requirementId);
    if (!requirement) return null;

    const presentation = presentationOf(requirement);
    const document = db.documents.find((d) => d.id === requirement.satisfiedByDocumentId);
    const subject = requirement.requiredOfCasePartyId
      ? partyName(db, requirement.requiredOfCasePartyId)
      : requirement.requiredOfCasePropertyId
        ? "Property"
        : "The case";

    // What the row is CALLED, as against what the domain calls it. "Pending"
    // covered both "the customer has sent nothing" and "a file is sitting here
    // unread"; those are two different phone calls (Part 8).
    const state = documentStateOf(requirement.status, requirement.applicability);

    // Why this is being asked for. A checklist nobody can interrogate is a
    // checklist people work around (Milestone 9).
    const rule = ruleBehind(requirement.id);
    const isOptional = requirement.applicability === "optional";

    return (
      <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 first:pt-0 last:pb-0">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {presentation.name}
            {/* The local name, quietly, on the same line. The customer says
                "Villangam" and the bank writes "Encumbrance Certificate", and
                a telecaller who only has one of the two is stuck (Part 3). */}
            {presentation.localName && (
              <span className="ml-1.5 text-xs font-normal text-ink-400">
                ({presentation.localName})
              </span>
            )}
          </p>
          {/* What to say when the customer asks "what is that?" */}
          {presentation.description && (
            <p className="mt-0.5 text-xs text-ink-500">{presentation.description}</p>
          )}
          {/* And what actually counts, where the answer is a list of things
              rather than a sentence. This is the address-proof question, and
              it gets asked on nearly every call. */}
          {presentation.examples && presentation.examples.length > 0 && (
            <ul className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
              {presentation.examples.map((example) => (
                <li key={example} className="text-xs text-ink-400">
                  • {example}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-0.5 text-xs text-ink-500">
            {subject}
            {document && ` · ${document.fileName} · ${bytes(document.fileSizeBytes)}`}
            {requirement.status === "waived" && ` · waived: ${requirement.reason}`}
            {requirement.status === "rejected" &&
              document?.rejectionReason &&
              ` · rejected: ${document.rejectionReason}`}
          </p>
          {rule && (
            <p className="mt-0.5 text-xs text-ink-400" title={rule.notes ?? rule.code}>
              Asked for by: {rule.name}
            </p>
          )}
          {requirement.isCustom && (
            <p className="mt-0.5 text-xs text-ink-400">Added by hand, for this case only</p>
          )}
        </div>

        {isOptional && !["pending"].includes(requirement.status) && <Badge>Optional</Badge>}
        <Badge
          tone={DOCUMENT_STATE_PRESENTATION[state].tone}
          title={DOCUMENT_STATE_PRESENTATION[state].meaning}
        >
          {DOCUMENT_STATE_PRESENTATION[state].label}
        </Badge>

        <div className="flex shrink-0 gap-1.5">
          {["pending", "rejected"].includes(requirement.status) &&
            session.can("document.upload", "own") && (
              <Button
                onClick={() => {
                  setUploadingFor(requirement.id);
                  fileInput.current?.click();
                }}
              >
                {requirement.status === "rejected" ? "Upload again" : "Upload"}
              </Button>
            )}
          {/* View, at every stage after upload and not only on the way to
              verifying (Part 6). A verified document that cannot be reopened
              is one nobody can check a query against three weeks later, and
              the file is right there. */}
          {document && (
            <Button variant="ghost" onClick={() => setViewFor(requirement.id)}>
              View
            </Button>
          )}
          {requirement.status === "received" && session.can("document.verify", "own") && (
            <Button variant="primary" onClick={() => setVerifyFor(requirement.id)}>
              Verify
            </Button>
          )}
          {/* Remove/Replace milestone: once something is uploaded, replacing it
              (received or already-verified) or removing it outright is always
              reachable from here — not only while it is still "pending". Both
              go through a confirmation dialog since both act on a document a
              human may already have verified. */}
          {document && ["received", "verified"].includes(requirement.status) &&
            session.can("document.upload", "own") && (
              <Button variant="ghost" onClick={() => setReplaceFor(requirement.id)}>
                Replace
              </Button>
            )}
          {document && session.can("document.upload", "own") && (
            <Button variant="ghost" onClick={() => setRemoveUploadFor(requirement.id)}>
              Remove upload
            </Button>
          )}
          {["pending", "received", "rejected"].includes(requirement.status) &&
            session.can("requirement.waive", "own") && (
              // Deliberately not styled like the routine actions beside it —
              // a waiver sends an incomplete file to a bank, and it should not
              // read as interchangeable with Upload/View/Replace at a glance
              // (audit finding 3.4). Same permission, same confirmation dialog,
              // same audit trail — only the visual weight changes.
              <Button
                variant="ghost"
                className="text-amber-800 ring-1 ring-amber-200 hover:bg-amber-50"
                onClick={() => {
                  setWaiveFor(requirement.id);
                }}
              >
                Waive
              </Button>
            )}
          {requirement.isCustom &&
            requirement.status !== "not_applicable" &&
            session.can("requirement.waive", "own") && (
              <Button variant="ghost" onClick={() => setRemoveCustomFor(requirement.id)}>
                Remove
              </Button>
            )}
        </div>
      </li>
    );
  };

  /**
   * One block of the checklist — "KYC Documents", "Business Documents", and
   * so on (Part 8).
   *
   * The flat list this replaces was accurate and unusable: forty rows in rule
   * order, with a PAN card three lines above a stock statement. A telecaller
   * reads a checklist ALOUD, one topic at a time, and the grouping is what
   * lets them say "now the business papers" instead of reading a list back
   * item by item.
   */
  const GroupedRows = ({ rows }: { rows: typeof requirements }): ReactNode => (
    <div className="space-y-5">
      {byCategory(rows).map((group) => (
        <div key={group.category}>
          <div className="mb-1 flex items-baseline gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-700">
              {DOCUMENT_CATEGORY_LABELS[group.category]}
            </h4>
            <span className="tnum text-xs text-ink-400">{group.rows.length}</span>
          </div>
          <p className="mb-1.5 text-xs text-ink-400">
            {DOCUMENT_CATEGORY_HINTS[group.category]}
          </p>
          <ul className="divide-y divide-ink-100 border-t border-ink-100 pt-1">
            {group.rows.map((requirement) => (
              <Row key={requirement.id} requirementId={requirement.id} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );

  return (
    <div className="space-y-6">
      <input ref={fileInput} type="file" className="hidden" onChange={onFileChosen} />

      <CaseFacts caseId={caseId} />

      <DocumentStateSummary caseId={caseId} />

      <Card
        title="Still needed"
        subtitle={
          outstanding.length === 0
            ? "Nothing outstanding. This file is complete."
            : // Counted the way the progress bar counts (Milestone 9): optional
              // requirements are listed and collected, but naming them as
              // "outstanding" beside a percentage that ignores them is two
              // numbers for one question.
              [
                `${outstanding.filter((r) => r.applicability !== "optional").length} outstanding`,
                progress.optionalCount > 0 ? `${progress.optionalCount} optional` : "",
                `${progress.percentComplete}% complete`,
              ]
                .filter(Boolean)
                .join(" · ")
        }
        actions={
          session.can("document.upload", "own") && (
            <Button onClick={() => setAddCustomOpen(true)}>+ Add document</Button>
          )
        }
      >
        {outstanding.length === 0 ? (
          <Empty>Nothing is missing before this file can go to a bank.</Empty>
        ) : (
          <GroupedRows rows={outstanding} />
        )}
      </Card>

      {fyGroups.length > 0 && (
        <Card
          title="Financial years"
          subtitle="GST returns, ITR, balance sheet, profit and loss and bank statements are tracked and verified per year — one filing never stands in for another year's"
        >
          <ul className="divide-y divide-ink-100">
            {fyGroups.map((group) => (
              <li key={group.key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{group.documentTypeName}</p>
                  <p className="text-xs text-ink-500">{group.subjectLabel}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {group.years.map(({ requirement, label }) => (
                    <Badge
                      key={requirement.id}
                      tone={
                        requirement.status === "verified"
                          ? "good"
                          : requirement.status === "received"
                            ? "info"
                            : requirement.status === "waived"
                              ? "warn"
                              : "neutral"
                      }
                    >
                      {label}
                    </Badge>
                  ))}
                </div>
                {session.can("document.upload", "own") && (
                  <Button onClick={() => setAddingYearFor(group)}>+ Another year</Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {upcoming.length > 0 && (
        <Card
          title="Not due yet"
          subtitle="Real requirements that become applicable at a later stage — shown as upcoming, never as missing"
        >
          <ul className="divide-y divide-ink-100">
            {upcoming.map((requirement) => {
              const presentation = presentationOf(requirement);
              return (
                <li key={requirement.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                  <span className="flex-1 text-sm text-ink-700">
                    {presentation.name}
                    {presentation.localName && (
                      <span className="ml-1.5 text-xs text-ink-400">
                        ({presentation.localName})
                      </span>
                    )}
                  </span>
                  <Badge>from {titleCase(requirement.applicableFromStage)}</Badge>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {settled.length > 0 && (
        <Card title="Settled" subtitle="Verified, waived, or no longer applicable">
          <GroupedRows rows={settled} />
        </Card>
      )}

      <Modal open={waiveFor !== null} title="Waive this requirement" onClose={() => setWaiveFor(null)}>
        <div className="space-y-3">
          <p className="text-sm text-ink-700">
            A waiver sends an incomplete file to a bank. That is a decision with a name on it — who,
            when and why are all recorded, and the waiver is excluded from progress rather than
            counted as done.
          </p>
          <Field label="Why">
            <Textarea
              value={waiveReason}
              onChange={(event) => setWaiveReason(event.target.value)}
              placeholder="RM agreed to accept the file and collect the payslip later"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setWaiveFor(null)}>Back</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!waiveFor) return;
                const result = waiveRequirement(waiveFor, waiveReason, session.user.id);
                toast.show(result.ok ? "Waived" : (result.message ?? ""), result.ok ? "good" : "bad");
                if (result.ok) {
                  setWaiveReason("");
                  setWaiveFor(null);
                }
              }}
            >
              Waive
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={removeCustomFor !== null}
        title="Stop asking for this document"
        onClose={() => setRemoveCustomFor(null)}
      >
        <div className="space-y-3">
          <p className="text-sm text-ink-700">
            This document was added by hand for this case, so removing it changes nothing anywhere
            else — no rule is touched. It is marked "no longer applicable" rather than deleted:
            somebody asked the customer for it, and that they did is part of what happened here.
          </p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRemoveCustomFor(null)}>Back</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!removeCustomFor) return;
                const result = removeCustomRequirement(removeCustomFor, session.user.id);
                toast.show(
                  result.ok ? "No longer asked for" : (result.message ?? ""),
                  result.ok ? "good" : "bad",
                );
                if (result.ok) setRemoveCustomFor(null);
              }}
            >
              Remove
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={replaceFor !== null}
        title="Replace the uploaded file?"
        onClose={() => setReplaceFor(null)}
      >
        <div className="space-y-3">
          <p className="text-sm text-ink-700">
            The current file is kept — nothing is deleted. It stays in this document's version
            history, and the new file you pick next becomes the active version the requirement is
            satisfied by. The requirement goes back to awaiting verification.
          </p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setReplaceFor(null)}>Back</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!replaceFor) return;
                setUploadingFor(replaceFor);
                setReplaceFor(null);
                fileInput.current?.click();
              }}
            >
              Choose replacement file
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={removeUploadFor !== null}
        title="Remove this upload?"
        onClose={() => setRemoveUploadFor(null)}
      >
        <div className="space-y-3">
          <p className="text-sm text-ink-700">
            The file is not deleted — it stays in this document's history, exactly as uploaded. Only
            the requirement's current upload is cleared: this row goes back to awaiting a file, and
            you can upload a replacement immediately. The requirement itself is not removed.
          </p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRemoveUploadFor(null)}>Back</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!removeUploadFor) return;
                const result = removeDocument(removeUploadFor, session.user.id);
                toast.show(
                  result.ok ? "Upload removed" : (result.message ?? ""),
                  result.ok ? "good" : "bad",
                );
                if (result.ok) setRemoveUploadFor(null);
              }}
            >
              Remove upload
            </Button>
          </div>
        </div>
      </Modal>

      <AddCustomDocumentDialog
        open={addCustomOpen}
        caseId={caseId}
        onClose={() => setAddCustomOpen(false)}
      />

      <AddFinancialYearDialog
        caseId={caseId}
        group={addingYearFor}
        onClose={() => setAddingYearFor(null)}
      />

      <ViewDocumentDialog requirementId={viewFor} onClose={() => setViewFor(null)} />

      <VerifyDialog requirementId={verifyFor} onClose={() => setVerifyFor(null)} />
    </div>
  );
}

/**
 * Where this case's collection actually stands (Part 8).
 *
 * Six words a telecaller uses, with the number against each, so "how far along
 * is this file?" has one answer instead of an impression formed from scrolling
 * the list. Every figure is derived from the same ProgressSummary the bar in
 * the header draws — see documentStateCounts — so the strip and the bar cannot
 * tell two different stories.
 *
 * The distinction this exists to make: UPLOADED IS NOT DONE. A case with
 * fifteen files uploaded and none verified is 0% complete, and it should look
 * it here.
 */
function DocumentStateSummary({ caseId }: { caseId: string }): ReactNode {
  const progress = progressFor(caseId);
  const counts = documentStateCounts(progress);

  const cells: Array<{ label: string; value: number; tone?: string }> = [
    { label: "Required", value: counts.required },
    { label: "Missing", value: counts.missing, tone: counts.missing > 0 ? "text-ink-900" : "" },
    { label: "Awaiting verification", value: counts.awaitingVerification },
    { label: "Rejected", value: counts.rejected, tone: counts.rejected > 0 ? "text-red-700" : "" },
    { label: "Verified", value: counts.verified, tone: counts.verified > 0 ? "text-green-700" : "" },
    { label: "Optional", value: counts.optional },
    { label: "Waived", value: counts.waived },
    { label: "Not due yet", value: counts.notDueYet },
  ];

  return (
    <Card
      title="Where this file stands"
      subtitle={
        counts.awaitingVerification > 0
          ? "Uploaded is not collected. Everything awaiting verification still needs a human to open it."
          : isDocumentCollectionComplete(progress)
            ? "Everything mandatory and due has been verified."
            : "Counted the same way the progress bar counts — verified, not uploaded."
      }
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {cells.map((cell) => (
          <div key={cell.label}>
            <dt className="text-xs text-ink-500">{cell.label}</dt>
            <dd className={cx("tnum text-lg font-semibold", cell.tone)}>{cell.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/**
 * The uploaded file itself, on screen.
 *
 * Shared by View and by Verify, because they are the same act — looking at
 * what arrived — differing only in what may be done afterwards. Two copies of
 * this would be two ways for a preview to be subtly wrong.
 */
function DocumentPreview({ document }: { document: DocumentFile }): ReactNode {
  const [preview, setPreview] = useState<
    { status: "loading" } | { status: "error" } | { status: "ready"; url: string; isImage: boolean }
  >({ status: "loading" });

  useEffect(() => {
    setPreview({ status: "loading" });

    let cancelled = false;
    let objectUrl: string | null = null;

    Promise.all([storageAdapter.get(document.filePath), storageAdapter.list(document.filePath)])
      .then(([fileBytes, entries]) => {
        if (cancelled) return;
        const contentType = entries.find((entry) => entry.path === document.filePath)?.contentType;
        const blob = new Blob(
          [fileBytes as BlobPart],
          contentType ? { type: contentType } : undefined,
        );
        objectUrl = URL.createObjectURL(blob);
        setPreview({
          status: "ready",
          url: objectUrl,
          isImage: (contentType ?? "").startsWith("image/"),
        });
      })
      .catch(() => {
        if (!cancelled) setPreview({ status: "error" });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [document.filePath]);

  return (
    <div className="flex min-h-40 items-center justify-center overflow-hidden rounded-md bg-ink-50 ring-1 ring-ink-200">
      {preview.status === "loading" && <p className="p-6 text-xs text-ink-500">Loading preview…</p>}
      {preview.status === "error" && (
        <p className="p-6 text-xs text-red-700">
          Could not load a preview from the storage backend.
        </p>
      )}
      {preview.status === "ready" &&
        (preview.isImage ? (
          <img
            src={preview.url}
            alt={document.fileName}
            className="max-h-80 w-full object-contain"
          />
        ) : (
          <iframe src={preview.url} title={document.fileName} className="h-80 w-full" />
        ))}
    </div>
  );
}

/** What is known about an uploaded file, without any judgement on it. */
function DocumentFacts({ document }: { document: DocumentFile }): ReactNode {
  const db = useDatabase();
  const uploader = db.users.find((u) => u.id === document.uploadedBy);
  const verifier = db.users.find((u) => u.id === document.verifiedBy);

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
      <div>
        <dt className="text-xs text-ink-500">Filename</dt>
        <dd className="truncate">{document.fileName}</dd>
      </div>
      <div>
        <dt className="text-xs text-ink-500">Current version</dt>
        <dd>v{document.version}</dd>
      </div>
      {document.periodStart && (
        <div>
          <dt className="text-xs text-ink-500">Financial year</dt>
          <dd>FY {financialYearOf(new Date(document.periodStart)).label}</dd>
        </div>
      )}
      <div>
        <dt className="text-xs text-ink-500">Uploaded by</dt>
        <dd>{uploader?.name ?? "—"}</dd>
      </div>
      <div>
        <dt className="text-xs text-ink-500">Uploaded on</dt>
        <dd>{exactly(document.uploadedAt)}</dd>
      </div>
      {document.verifiedAt && (
        <div>
          <dt className="text-xs text-ink-500">Verified</dt>
          <dd>
            {verifier?.name ?? "Someone"} · {exactly(document.verifiedAt)}
          </dd>
        </div>
      )}
    </dl>
  );
}

/**
 * Every version this document superseded, most-recent-first — the Remove/
 * Replace milestone's "do not silently destroy the historical record" made
 * visible. Deliberately just the superseded versions: the current one is
 * already on screen via DocumentFacts above, and repeating it here would be
 * the "visually overwhelming" the milestone specifically asked to avoid.
 */
function DocumentVersionHistory({ document }: { document: DocumentFile }): ReactNode {
  const db = useDatabase();
  const chain = versionHistory(db.documents, document.id);
  const previous = chain.slice(1).map((id) => db.documents.find((d) => d.id === id));

  if (previous.length === 0) return null;

  return (
    <div>
      <p className="mb-1 text-xs font-medium text-ink-700">Previous uploads</p>
      <ul className="divide-y divide-ink-100 rounded-md border border-ink-100">
        {previous.map((doc) => {
          if (!doc) return null;
          const uploader = db.users.find((u) => u.id === doc.uploadedBy);
          const verifier = db.users.find((u) => u.id === doc.verifiedBy);
          const rejecter = db.users.find((u) => u.id === doc.rejectedBy);
          const statusText = doc.rejectedAt
            ? `Rejected by ${rejecter?.name ?? "someone"} · ${exactly(doc.rejectedAt)}`
            : doc.verifiedAt
              ? `Verified by ${verifier?.name ?? "someone"} · ${exactly(doc.verifiedAt)}`
              : "Superseded before it was verified or rejected";
          return (
            <li key={doc.id} className="px-2.5 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-medium text-ink-700">
                  v{doc.version} · {doc.fileName}
                </span>
                <span className="shrink-0 text-ink-400">{exactly(doc.uploadedAt)}</span>
              </div>
              <p className="mt-0.5 text-ink-500">
                Uploaded by {uploader?.name ?? "someone"} · {statusText}
              </p>
              {doc.rejectionReason && <p className="mt-0.5 text-ink-500">Reason: {doc.rejectionReason}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * View — the step between Upload and Verify (Part 6).
 *
 * Read-only on purpose. Opening a document to check what the customer sent, or
 * to answer a bank's query about a file verified three weeks ago, should not
 * put a Verify button under the reader's cursor.
 */
function ViewDocumentDialog({
  requirementId,
  onClose,
}: {
  requirementId: string | null;
  onClose: () => void;
}): ReactNode {
  const db = useDatabase();

  const requirement = db.requirements.find((r) => r.id === requirementId);
  const document = db.documents.find((d) => d.id === requirement?.satisfiedByDocumentId);
  const documentType = db.documentTypes.find((t) => t.id === requirement?.documentTypeId);

  if (!requirement || !document) return null;

  const state = documentStateOf(requirement.status, requirement.applicability);

  return (
    <Modal
      open={requirementId !== null}
      title={requirement.customName ?? documentType?.name ?? "Document"}
      onClose={onClose}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Badge tone={DOCUMENT_STATE_PRESENTATION[state].tone}>
            {DOCUMENT_STATE_PRESENTATION[state].label}
          </Badge>
          <span className="text-xs text-ink-500">
            {DOCUMENT_STATE_PRESENTATION[state].meaning}
          </span>
        </div>

        <DocumentPreview document={document} />
        <DocumentFacts document={document} />
        <DocumentVersionHistory document={document} />

        {document.verificationNotes && (
          <p className="rounded bg-ink-50 px-3 py-2 text-sm text-ink-700">
            Verification note: {document.verificationNotes}
          </p>
        )}
        {document.rejectionReason && (
          <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-900">
            Rejected: {document.rejectionReason}
          </p>
        )}

        <div>
          <p className="mb-1 text-xs font-medium text-ink-700">Storage location</p>
          <StorageLocation
            filePath={document.filePath}
            {...(document.storageRoot ? { documentStorageRoot: document.storageRoot } : {})}
          />
        </div>

        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Add a document requirement to this case by hand (Part 6).
 *
 * The workflow the milestone asks for, in order: category, name, mandatory or
 * optional, description — then Save, after which the document appears in its
 * group and is uploaded, verified and versioned exactly like a generated one.
 * That last part is the requirement that matters: a custom document that
 * cannot be verified is a sticky note, and a sticky note is what this feature
 * exists to replace.
 *
 * Everything typed here is drafted (Part 7), so closing the dialog to go and
 * check something does not cost the user their description.
 *
 * NO MASTER RULE IS TOUCHED. The row lands on this case and nowhere else.
 */
function AddCustomDocumentDialog({
  open,
  caseId,
  onClose,
}: {
  open: boolean;
  caseId: string;
  onClose: () => void;
}): ReactNode {
  const session = useSession();
  const toast = useToast();

  const prefix = `case:${caseId}:custom-doc`;
  const [category, setCategory] = useDraft(`${prefix}:category`);
  const [name, setName] = useDraft(`${prefix}:name`);
  const [applicability, setApplicability] = useDraft(`${prefix}:applicability`);
  const [description, setDescription] = useDraft(`${prefix}:description`);

  const chosenCategory = (category || "additional") as DocumentCategory;
  const chosenApplicability = applicability === "optional" ? "optional" : "mandatory";
  const ready = name.trim().length > 1;

  const save = (): void => {
    const result = addCustomRequirement(
      caseId,
      {
        category: chosenCategory,
        name,
        applicability: chosenApplicability,
        ...(description.trim() ? { description } : {}),
      },
      session.user.id,
    );
    if (!result.ok) {
      toast.show(result.message ?? "", "bad");
      return;
    }
    toast.show(`"${name.trim()}" added to this case's list.`);
    clearDrafts(prefix);
    onClose();
  };

  return (
    <Modal open={open} title="Add a document to this case" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-ink-700">
          For the exception the rules could not have known about — one bank asking for one extra
          letter on one file. This is added to <em>this case only</em>. No rule changes, and no
          other case is affected.
        </p>

        <Field label="Category" hint="Which block of the checklist it belongs in.">
          <Select value={chosenCategory} onChange={(event) => setCategory(event.target.value)}>
            {DOCUMENT_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {DOCUMENT_CATEGORY_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Document name"
          hint="What you would call it on the phone — the customer has to recognise it."
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Bank's NOC for the second charge"
          />
        </Field>

        <Field
          label="Mandatory or optional"
          hint="Optional documents are collected and verified like any other, but never counted against the case's completeness."
        >
          <Select
            value={chosenApplicability}
            onChange={(event) => setApplicability(event.target.value)}
          >
            <option value="mandatory">Mandatory</option>
            <option value="optional">Optional</option>
          </Select>
        </Field>

        <Field
          label="Description"
          hint="Optional. One sentence somebody in their first week could read out to the customer."
        >
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Letter from the existing bank agreeing to a second charge on the property."
          />
        </Field>

        <p className="text-xs text-ink-500">
          After saving, upload and verify it from the list like any other document.
        </p>

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Back
          </Button>
          <Button
            onClick={() => {
              toast.show("Draft kept. It will be here when you come back.");
              onClose();
            }}
          >
            Save draft
          </Button>
          <Button variant="primary" disabled={!ready} onClick={save}>
            Save &amp; continue
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The facts the Document Requirement Engine reads, on the page whose contents
 * they decide (Milestone 9, ADR-035).
 *
 * Here rather than on the Overview tab on purpose: the milestone's promise is
 * that the checklist changes the moment a fact does, and a promise the user
 * has to switch tabs to observe is one they will never notice being kept.
 * Every control below writes through a store mutation that regenerates, so
 * there is no refresh and no "recalculate" button.
 *
 * Each answer is three-valued. "Not asked" is a real state and is offered as
 * one: recording "no" and never having asked are different facts, and a
 * checklist built on the assumption that unanswered means no is a checklist
 * that quietly stops asking for things.
 */
function CaseFacts({ caseId }: { caseId: string }): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [propertyOpen, setPropertyOpen] = useState(false);

  const loanCase = db.cases.find((c) => c.id === caseId);
  if (!loanCase) return null;

  const canEdit =
    session.can("case.update", "all") ||
    (session.can("case.update", "own") && loanCase.ownerUserId === session.user.id);

  const product = db.loanProducts.find((p) => p.id === loanCase.loanProductId);
  const properties = db.caseProperties.filter((p) => p.caseId === caseId);
  const parties = db.caseParties.filter((p) => p.caseId === caseId && !p.removedAt);

  const tri = (value: boolean | undefined): string =>
    value === undefined ? "Not asked" : value ? "Yes" : "No";

  const set = (input: Parameters<typeof updateCaseFacts>[1]): void => {
    const result = updateCaseFacts(caseId, input, session.user.id);
    if (!result.ok) toast.show(result.message ?? "", "bad");
  };

  return (
    <>
      <Card
        title="What this case is"
        subtitle="Every document below is generated from these facts. Change one and the checklist changes with it — no refresh."
        actions={
          canEdit && (
            <div className="flex gap-1.5">
              <Button onClick={() => setPropertyOpen(true)}>Add property</Button>
              <Button onClick={() => setOpen(true)}>Edit facts</Button>
            </div>
          )
        }
      >
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Lending product" value={product?.name ?? product?.variant ?? "—"} />
          <Fact
            label="Amount asked for"
            value={loanCase.requestedAmount ? money(loanCase.requestedAmount) : "Not asked"}
          />
          <Fact
            label="Property on file"
            value={properties.length === 0 ? "None" : `${properties.length}`}
            hint={
              properties.length === 0
                ? "No property means no property documents at all — not rows marked N/A"
                : undefined
            }
          />
          <Fact label="GST registered" value={tri(loanCase.isGstRegistered)} />
          <Fact
            label="Existing obligations"
            value={tri(loanCase.hasExistingObligations)}
            hint="Asked and answered under Existing loans and EMIs, on the Overview"
          />
          <Fact
            label="Construction stage"
            value={loanCase.constructionStage ? titleCase(loanCase.constructionStage) : "—"}
          />
          <Fact
            label="People on the file"
            value={parties
              .filter((p) => p.role !== "referrer")
              .map((p) => titleCase(p.role))
              .join(", ")}
            hint="Occupation and business type are set per person, under People on this case"
          />
        </dl>

        {canEdit && (
          <div className="mt-4 border-t border-ink-100 pt-3">
            <Button
              variant="ghost"
              onClick={() => {
                const result = reevaluateRequirements(caseId, session.user.id);
                toast.show(
                  result.ok ? "Re-evaluated against the current rules." : (result.message ?? ""),
                  result.ok ? "good" : "bad",
                );
              }}
            >
              Re-evaluate against current rules
            </Button>
            <p className="mt-1 text-xs text-ink-500">
              Editing a rule does not silently rewrite every open case. This brings just this one
              up to date.
            </p>
          </div>
        )}
      </Card>

      <EditFactsDialog open={open} caseId={caseId} onClose={() => setOpen(false)} onSave={set} />
      <AddPropertyDialog
        open={propertyOpen}
        caseId={caseId}
        onClose={() => setPropertyOpen(false)}
      />
    </>
  );
}

/**
 * The existing-obligations question, as a workflow rather than a field
 * (Part 2).
 *
 * WHAT THE DOMAIN ACTUALLY MODELS, AND WHY THIS IS SHAPED THAT WAY
 *
 * One three-valued fact on the case: `loan_case.has_existing_obligations`
 * (Database/migrations/0021). There is no obligations table, no EMI column and
 * no per-loan row anywhere in the schema — and inventing one here would be a
 * data model this milestone was told not to design. So the FACT stays exactly
 * what the engine reads, and what is added is the missing half: a way to ask
 * the question, in place, on the screen where its answer is displayed.
 *
 * Before this, the only route to the answer was the fourth dropdown of a modal
 * behind an "Edit facts" button, while the Overview showed "Existing
 * obligations: Not asked" with nothing to press. "Not asked" is a true and
 * useful state — it is not the same as "no" and must never be recorded as one
 * — but it should read as a question outstanding, not as a gap in the screen.
 *
 * MULTIPLE LOANS. A customer servicing three loans needs three statements, and
 * the rule raises one row per party. The extra ones are added through the
 * existing per-case custom-requirement mechanism — named for the lender they
 * belong to, collected and verified like any other document, touching no rule
 * and no other case. That is the multiplicity the domain supports today; a
 * structured obligation record with amounts and tenures is a different
 * milestone and is deliberately not started here.
 */
function ExistingObligations({ caseId }: { caseId: string }): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const toast = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [lender, setLender] = useDraft(`case:${caseId}:obligation-lender`);

  const loanCase = db.cases.find((c) => c.id === caseId);
  if (!loanCase) return null;

  const canEdit =
    session.can("case.update", "all") ||
    (session.can("case.update", "own") && loanCase.ownerUserId === session.user.id);

  const answer = loanCase.hasExistingObligations;

  const statementType = db.documentTypes.find((t) => t.code === "existing_loan_statement");
  // Both halves of what is being collected: the rows the rule raised, and the
  // extra ones a user added for a second and third live loan.
  const statements = db.requirements.filter(
    (r) =>
      r.caseId === caseId &&
      r.status !== "not_applicable" &&
      (r.documentTypeId === statementType?.id ||
        (r.isCustom === true && r.customName?.toLowerCase().includes("loan statement") === true)),
  );

  const answerLabel =
    answer === undefined
      ? "Not asked yet"
      : answer
        ? "Yes — already servicing a loan"
        : "No live loans";

  const record = (value: boolean | undefined): void => {
    const result = updateCaseFacts(
      caseId,
      { hasExistingObligations: value, ...factsToPreserve(loanCase) },
      session.user.id,
    );
    if (!result.ok) {
      toast.show(result.message ?? "", "bad");
      return;
    }
    toast.show(
      value === undefined
        ? "Back to unanswered. The loan statement is no longer being asked for."
        : value
          ? "Recorded. The existing loan statement is on the documents list."
          : "Recorded. No loan statement is being asked for.",
    );
  };

  const addStatement = (): void => {
    const name = `Existing Loan Statement — ${lender.trim()}`;
    const result = addCustomRequirement(
      caseId,
      {
        category: "income",
        name,
        applicability: "mandatory",
        description:
          "Statement for a second live loan, showing the EMI and how regularly it is paid.",
      },
      session.user.id,
    );
    if (!result.ok) {
      toast.show(result.message ?? "", "bad");
      return;
    }
    toast.show(`${name} added to this case's list.`);
    setLender("");
    setAddOpen(false);
  };

  return (
    <>
      <Card
        title="Existing loans and EMIs"
        subtitle="Whether anyone on this file is already repaying a loan. It decides whether a loan statement is collected, and it is half of what a bank reads as FOIR."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={answer === undefined ? "warn" : answer ? "info" : "neutral"}>
            {answerLabel}
          </Badge>
          {canEdit && (
            <div className="flex flex-wrap gap-1.5">
              <Button variant={answer === true ? "primary" : "ghost"} onClick={() => record(true)}>
                Yes
              </Button>
              <Button variant={answer === false ? "primary" : "ghost"} onClick={() => record(false)}>
                No
              </Button>
              {answer !== undefined && (
                <Button variant="ghost" onClick={() => record(undefined)}>
                  Clear the answer
                </Button>
              )}
            </div>
          )}
        </div>

        {answer === undefined && (
          <p className="mt-2 text-sm text-amber-700">
            Still to ask. Nothing is assumed from silence — no loan statement is being requested,
            and none is being ruled out either.
          </p>
        )}

        {answer === false && (
          <p className="mt-2 text-sm text-ink-500">
            Recorded as no. If the customer mentions a live loan later, answer Yes here and the
            statement appears on the documents list immediately.
          </p>
        )}

        {answer === true && (
          <div className="mt-3 border-t border-ink-100 pt-3">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <p className="text-xs font-medium text-ink-700">Statements being collected</p>
              {session.can("document.upload", "own") && (
                <Button variant="ghost" onClick={() => setAddOpen(true)}>
                  + Another loan
                </Button>
              )}
            </div>
            {statements.length === 0 ? (
              <Empty>
                No statement row yet — the rule raises one per applicant from the documents-pending
                stage.
              </Empty>
            ) : (
              <ul className="divide-y divide-ink-100">
                {statements.map((requirement) => (
                  <li key={requirement.id} className="flex items-center gap-3 py-2">
                    <span className="min-w-0 flex-1 text-sm">
                      {requirement.customName ?? statementType?.name ?? "Existing Loan Statement"}
                      <span className="ml-1.5 text-xs text-ink-500">
                        {requirement.requiredOfCasePartyId
                          ? partyName(db, requirement.requiredOfCasePartyId)
                          : "The case"}
                      </span>
                    </span>
                    <Badge tone={documentStateTone(requirement.status, requirement.applicability)}>
                      {documentStateLabel(requirement.status, requirement.applicability)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-ink-500">
              A customer repaying more than one loan needs a statement for each. Add the others
              here — they land on this case only and are uploaded and verified like any other
              document.
            </p>
          </div>
        )}
      </Card>

      <Modal open={addOpen} title="Another live loan" onClose={() => setAddOpen(false)}>
        <div className="space-y-3">
          <p className="text-sm text-ink-700">
            Name the lender, so the two statements are told apart on the list and on the phone.
            This adds one document to <em>this case</em> — no rule changes.
          </p>
          <Field label="Who is the loan with?" hint="e.g. HDFC, Bajaj, the local chit fund.">
            <Input
              value={lender}
              onChange={(event) => setLender(event.target.value)}
              placeholder="HDFC Bank"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setAddOpen(false)}>Back</Button>
            <Button variant="primary" disabled={lender.trim().length < 2} onClick={addStatement}>
              Add the statement
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/**
 * The other case facts, restated so that saving one does not clear the rest.
 *
 * `updateCaseFacts` takes the whole set and treats an absent key as "cleared
 * back to unasked" — deliberately, because clearing an answer has to be
 * possible. A caller changing ONE fact therefore has to say what the others
 * still are, and doing that by hand at each call site is how a Yes/No button
 * quietly wipes a construction stage.
 */
function factsToPreserve(loanCase: {
  isGstRegistered?: boolean | undefined;
  constructionStage?: (typeof CONSTRUCTION_STAGES)[number] | undefined;
  requestedAmount?: number | undefined;
}): Parameters<typeof updateCaseFacts>[1] {
  return {
    ...(loanCase.isGstRegistered !== undefined
      ? { isGstRegistered: loanCase.isGstRegistered }
      : {}),
    ...(loanCase.constructionStage ? { constructionStage: loanCase.constructionStage } : {}),
    ...(loanCase.requestedAmount !== undefined
      ? { requestedAmount: loanCase.requestedAmount }
      : {}),
  };
}

function Fact({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
}): ReactNode {
  return (
    <div>
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="text-sm font-medium">{value || "—"}</dd>
      {hint && <p className="mt-0.5 text-xs text-ink-400">{hint}</p>}
    </div>
  );
}

function EditFactsDialog({
  open,
  caseId,
  onClose,
  onSave,
}: {
  open: boolean;
  caseId: string;
  onClose: () => void;
  onSave: (input: Parameters<typeof updateCaseFacts>[1]) => void;
}): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const toast = useToast();
  const loanCase = db.cases.find((c) => c.id === caseId);

  const [gst, setGst] = useState("");
  const [obligations, setObligations] = useState("");
  const [stage, setStage] = useState("");
  const [productId, setProductId] = useState("");
  const [amount, setAmount] = useState("");

  useEffect(() => {
    if (!open || !loanCase) return;
    setGst(loanCase.isGstRegistered === undefined ? "" : String(loanCase.isGstRegistered));
    setObligations(
      loanCase.hasExistingObligations === undefined
        ? ""
        : String(loanCase.hasExistingObligations),
    );
    setStage(loanCase.constructionStage ?? "");
    setProductId(loanCase.loanProductId);
    setAmount(loanCase.requestedAmount === undefined ? "" : String(loanCase.requestedAmount));
  }, [open, loanCase]);

  if (!loanCase) return null;

  const parse = (value: string): boolean | undefined =>
    value === "" ? undefined : value === "true";

  const parsedAmount = amount.trim() === "" ? undefined : Number(amount);
  const amountIsBad = parsedAmount !== undefined && !Number.isFinite(parsedAmount);

  /**
   * Save without closing (Part 7). The facts are saved the instant this
   * runs — the whole card regenerates behind the dialog — so "Save draft"
   * here means "keep it saved and stay put", which is what a user working
   * through several answers actually wants. Nothing is held back and there is
   * nothing to lose by navigating away.
   */
  const commitFacts = (): boolean => {
    if (amountIsBad) {
      toast.show("The amount has to be a number.", "bad");
      return false;
    }
    if (productId !== loanCase.loanProductId) {
      const result = changeLoanProduct(caseId, productId, session.user.id);
      if (!result.ok) {
        toast.show(result.message ?? "", "bad");
        return false;
      }
    }
    onSave({
      isGstRegistered: parse(gst),
      hasExistingObligations: parse(obligations),
      ...(parsedAmount !== undefined ? { requestedAmount: parsedAmount } : {}),
      ...(stage ? { constructionStage: stage as (typeof CONSTRUCTION_STAGES)[number] } : {}),
    });
    return true;
  };

  return (
    <Modal open={open} title="What this case is" onClose={onClose}>
      <div className="space-y-3">
        <Field
          label="Lending product"
          hint="Changing this does not delete the old product's documents — they stop counting and stay in the history (BR-034)."
        >
          <Select value={productId} onChange={(event) => setProductId(event.target.value)}>
            {db.loanProducts
              .filter((product) => product.isActive)
              .map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name ?? product.variant}
                </option>
              ))}
          </Select>
        </Field>

        <Field
          label="Amount asked for"
          hint="In rupees. Shown at the top of the case, and some rules ask about it."
        >
          <Input
            type="number"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="1500000"
          />
        </Field>

        <Field
          label="Is the business registered under GST?"
          hint="No registration, no GST rows. Leaving it unanswered is honest and generates nothing either way."
        >
          <Select value={gst} onChange={(event) => setGst(event.target.value)}>
            <option value="">Not asked yet</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </Select>
        </Field>

        <Field
          label="Is anyone on this file already servicing a loan?"
          hint="Drives the existing-loan statement."
        >
          <Select value={obligations} onChange={(event) => setObligations(event.target.value)}>
            <option value="">Not asked yet</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </Select>
        </Field>

        <Field
          label="Construction stage"
          hint="Only meaningful on a construction loan. Nothing to report before the first brick, so the progress report does not exist until building starts."
        >
          <Select value={stage} onChange={(event) => setStage(event.target.value)}>
            <option value="">—</option>
            {CONSTRUCTION_STAGES.map((value) => (
              <option key={value} value={value}>
                {titleCase(value)}
              </option>
            ))}
          </Select>
        </Field>

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Back
          </Button>
          <Button
            onClick={() => {
              if (commitFacts()) toast.show("Saved. The documents list has already changed.");
            }}
          >
            Save draft
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (commitFacts()) onClose();
            }}
          >
            Save &amp; continue
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AddPropertyDialog({
  open,
  caseId,
  onClose,
}: {
  open: boolean;
  caseId: string;
  onClose: () => void;
}): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const toast = useToast();
  const [locality, setLocality] = useState("");
  const [city, setCity] = useState("");
  const [typeId, setTypeId] = useState("");
  const [role, setRole] = useState<"collateral" | "purchase" | "both">("collateral");

  return (
    <Modal open={open} title="Add a property" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-ink-700">
          Property documents exist because a property does. Adding one here generates the title,
          revenue and encumbrance documents immediately — including the Tamil Nadu ones a generic
          checklist misses.
        </p>

        <Field label="Locality">
          <Input value={locality} onChange={(event) => setLocality(event.target.value)} />
        </Field>
        <Field label="City">
          <Input value={city} onChange={(event) => setCity(event.target.value)} />
        </Field>
        <Field
          label="Property type"
          hint="An apartment on undivided share is the one common case with no patta of its own."
        >
          <Select value={typeId} onChange={(event) => setTypeId(event.target.value)}>
            <option value="">—</option>
            {db.propertyTypes
              .filter((type) => type.isActive)
              .map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Role on this case">
          <Select
            value={role}
            onChange={(event) => setRole(event.target.value as typeof role)}
          >
            <option value="collateral">Collateral</option>
            <option value="purchase">Purchase</option>
            <option value="both">Both</option>
          </Select>
        </Field>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Back
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const result = addCaseProperty(
                caseId,
                {
                  role,
                  newPropertyLocality: locality,
                  newPropertyCity: city,
                  ...(typeId ? { newPropertyTypeId: typeId } : {}),
                },
                session.user.id,
              );
              if (!result.ok) {
                toast.show(result.message ?? "", "bad");
                return;
              }
              toast.show("Property added. The property documents are on the list already.");
              setLocality("");
              setCity("");
              setTypeId("");
              onClose();
            }}
          >
            Save &amp; continue
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function VerifyDialog({
  requirementId,
  onClose,
}: {
  requirementId: string | null;
  onClose: () => void;
}): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const toast = useToast();
  const [notes, setNotes] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const requirement = db.requirements.find((r) => r.id === requirementId);
  const document = db.documents.find((d) => d.id === requirement?.satisfiedByDocumentId);
  const expectedType = db.documentTypes.find((t) => t.id === requirement?.documentTypeId);

  useEffect(() => {
    setNotes("");
    setRejecting(false);
    setRejectReason("");
  }, [requirementId]);

  if (!requirement || !document) return null;

  // What was ASKED FOR, in the words on the checklist row — including the
  // financial year, which is half the question on an ITR or a GST return.
  const askedFor =
    requirement.customName ??
    documentRowLabel(
      expectedType?.name ?? "Document",
      requirement.periodStart
        ? financialYearOf(new Date(requirement.periodStart)).label
        : undefined,
      expectedType?.periodKind,
    );

  return (
    <Modal open={requirementId !== null} title={`Verify: ${askedFor}`} onClose={onClose}>
      <div className="space-y-3">
        {/* THE QUESTION, ASKED OUT LOUD (Part 6).
            AOS cannot tell whether these bytes are an ITR, a PAN card or a
            photograph of a wall, and pretending otherwise would put a
            confident wrong answer where a human judgement belongs. There is no
            OCR here and none is implied: a person looks at the file and says
            yes or no, and that judgement — with their name on it — is what
            "verified" means in this system. */}
        <div className="rounded-md bg-brand-100 px-3 py-2">
          <p className="text-sm font-medium text-ink-900">
            Is the file below the <span className="underline">{askedFor}</span> that was asked for?
          </p>
          <p className="mt-0.5 text-xs text-ink-700">
            Open it and look. AOS cannot read the file — confirming is your judgement, recorded
            against your name, and it is what marks this requirement verified.
          </p>
        </div>

        <DocumentPreview document={document} />

        <DocumentFacts document={document} />
        <DocumentVersionHistory document={document} />

        <div>
          <p className="mb-1 text-xs font-medium text-ink-700">Storage location</p>
          <StorageLocation
            filePath={document.filePath}
            {...(document.storageRoot ? { documentStorageRoot: document.storageRoot } : {})}
          />
        </div>

        <Field
          label="Verification notes"
          hint={
            'Optional — becomes part of this document\'s history. e.g. "PAN readable." or ' +
            '"Uploaded Aadhaar is blurry."'
          }
        >
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>

        {rejecting && (
          <Field label="Reason for rejection" hint="Required.">
            <Textarea
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              placeholder="Uploaded Aadhaar is blurry — asked customer to re-upload"
            />
          </Field>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>Not now</Button>
          {rejecting ? (
            <Button
              variant="danger"
              onClick={() => {
                const result = rejectDocument(requirement.id, rejectReason, session.user.id);
                toast.show(result.ok ? "Rejected" : (result.message ?? ""), result.ok ? "good" : "bad");
                if (result.ok) onClose();
              }}
            >
              Confirm rejection
            </Button>
          ) : (
            <>
              <Button variant="danger" onClick={() => setRejecting(true)}>
                No — wrong or unreadable
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const result = verifyDocument(requirement.id, session.user.id, notes);
                  toast.show(
                    result.ok ? "Verified" : (result.message ?? ""),
                    result.ok ? "good" : "bad",
                  );
                  if (result.ok) onClose();
                }}
              >
                Yes — confirm &amp; verify
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function AddFinancialYearDialog({
  caseId,
  group,
  onClose,
}: {
  caseId: string;
  group: FyGroup | null;
  onClose: () => void;
}): ReactNode {
  const session = useSession();
  const toast = useToast();
  const [selected, setSelected] = useState("");

  const options = group
    ? selectableFinancialYears(caseId, group.documentTypeId, {
        ...(group.casePartyId ? { casePartyId: group.casePartyId } : {}),
        ...(group.casePropertyId ? { casePropertyId: group.casePropertyId } : {}),
      })
    : [];

  const close = (): void => {
    setSelected("");
    onClose();
  };

  return (
    <Modal
      open={group !== null}
      title={group ? `Request another year — ${group.documentTypeName}` : "Request another year"}
      onClose={close}
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-700">
          The default window covers the common case. If a bank has asked for one more year than
          usual, add it here — it becomes its own row, uploaded and verified independently of the
          others.
        </p>
        {options.length === 0 ? (
          <p className="text-sm text-ink-500">
            Nothing further back is available to request for this document type.
          </p>
        ) : (
          <Field label="Financial year">
            <Select value={selected} onChange={(event) => setSelected(event.target.value)}>
              <option value="">Choose…</option>
              {options.map((fy) => (
                <option key={fy.startDate} value={fy.startDate}>
                  FY {fy.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!selected || !group}
            onClick={() => {
              if (!group) return;
              const financialYear = options.find((option) => option.startDate === selected);
              if (!financialYear) return;
              const result = addFinancialYearRequirement(
                caseId,
                group.documentTypeId,
                {
                  ...(group.casePartyId ? { casePartyId: group.casePartyId } : {}),
                  ...(group.casePropertyId ? { casePropertyId: group.casePropertyId } : {}),
                },
                financialYear,
                session.user.id,
              );
              toast.show(result.ok ? "Added" : (result.message ?? ""), result.ok ? "good" : "bad");
              if (result.ok) close();
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
// Banks — the second axis
// ---------------------------------------------------------------------------

const NEXT_STATUS: Record<SubmissionStatus, SubmissionStatus[]> = {
  not_submitted: ["submitted", "withdrawn"],
  submitted: ["under_process", "rejected", "withdrawn"],
  under_process: ["query_raised", "eligibility_received", "rejected", "withdrawn"],
  query_raised: ["under_process", "rejected", "withdrawn"],
  eligibility_received: ["sanctioned", "rejected", "withdrawn"],
  sanctioned: ["disbursed", "withdrawn"],
  rejected: [],
  withdrawn: [],
  disbursed: [],
};

function Banks({ caseId }: { caseId: string }): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const toast = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [sanctioning, setSanctioning] = useState<string | null>(null);

  const submissions = db.submissions.filter((s) => s.caseId === caseId);

  if (!session.can("submission.read", "own")) {
    return (
      <Card title="Not visible to this user">
        <p className="text-sm text-ink-700">You don't have access to this case's bank submissions.</p>
        <PermissionCode code="submission.read" />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card
        title="Submissions"
        subtitle="Each bank moves independently. A case can be sanctioned at one and rejected at another — both are true."
        actions={
          session.can("submission.create", "own") && (
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              Add Bank
            </Button>
          )
        }
      >
        {submissions.length === 0 ? (
          <Empty>
            {session.can("submission.create", "own")
              ? "No bank added to this file yet."
              : "No bank added yet. Bank selection and submission are handled by Login Desk, once documents are collected."}
          </Empty>
        ) : (
          <ul className="divide-y divide-ink-100">
            {submissions.map((submission) => {
              const offers = db.offers.filter((o) => o.submissionId === submission.id);
              const reason = db.rejectionReasons.find(
                (r) => r.id === submission.rejectionReasonId,
              );
              const recipients = recipientsOf(submission.id, db);

              return (
                <li key={submission.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {/* The snapshot, not the live branch name: renaming a
                        branch in Master Data must not rewrite what this file
                        says it did (ADR-036). */}
                    <span className="text-sm font-medium">{counterpartyOf(submission, db)}</span>
                    <Badge
                      tone={
                        submission.status === "rejected"
                          ? "bad"
                          : ["sanctioned", "disbursed"].includes(submission.status)
                            ? "good"
                            : submission.status === "not_submitted"
                              ? "neutral"
                              : "info"
                      }
                    >
                      {titleCase(submission.status)}
                    </Badge>
                    {submission.status === "not_submitted" && (
                      <span className="text-xs text-ink-500">
                        Prepared, not yet dispatched — the case stage moves when it goes out
                      </span>
                    )}
                    <span className="ml-auto text-xs text-ink-500">
                      {submission.submittedAt ? `Sent ${when(submission.submittedAt)}` : "Not sent"}
                    </span>
                  </div>

                  {recipients.length > 0 && (
                    <p className="mt-1 text-xs text-ink-500">
                      {recipients.map((recipient, index) => (
                        <span key={recipient.id}>
                          {index > 0 && " · "}
                          <span className={recipient.isPrimary ? "font-medium text-ink-700" : ""}>
                            {recipient.contactName
                              ? `${recipient.contactName} — ${recipient.email}`
                              : recipient.email}
                          </span>
                          {recipient.recipientKind === "cc" && (
                            <span className="text-ink-400"> (cc)</span>
                          )}
                        </span>
                      ))}
                    </p>
                  )}

                  {reason && (
                    <div className="mt-1.5 rounded bg-red-50 px-3 py-2">
                      <p className="text-sm text-red-900">{reason.name}</p>
                      {submission.bankReasonText && (
                        <p className="mt-0.5 text-xs text-red-800">
                          Bank's wording: "{submission.bankReasonText}"
                        </p>
                      )}
                    </div>
                  )}

                  {offers.map((offer) => (
                    <div
                      key={offer.id}
                      className="mt-1.5 flex flex-wrap items-center gap-3 rounded bg-emerald-50 px-3 py-2"
                    >
                      <span className="tnum text-sm text-emerald-900">
                        {money(offer.sanctionedAmount)}
                        {offer.interestRate && ` · ${offer.interestRate}%`}
                        {offer.tenureMonths && ` · ${offer.tenureMonths / 12} yrs`}
                      </span>
                      {offer.validUntil && (
                        <Badge tone={new Date(offer.validUntil) < new Date() ? "bad" : "warn"}>
                          {new Date(offer.validUntil) < new Date() ? "Expired" : "Valid"}{" "}
                          {when(offer.validUntil)}
                        </Badge>
                      )}
                      {offer.isAccepted ? (
                        <Badge tone="good">Accepted</Badge>
                      ) : (
                        session.can("offer.accept", "own") && (
                          <Button
                            className="ml-auto"
                            onClick={() => {
                              acceptOffer(offer.id, session.user.id);
                              toast.show(
                                "Accepted. The other live submissions were withdrawn — our choice to stop, not theirs.",
                              );
                            }}
                          >
                            Accept
                          </Button>
                        )
                      )}
                    </div>
                  ))}

                  {session.can("submission.update_status", "own") &&
                    NEXT_STATUS[submission.status].length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {NEXT_STATUS[submission.status].map((status) => (
                          <Button
                            key={status}
                            onClick={() => {
                              if (status === "rejected") {
                                setRejecting(submission.id);
                                return;
                              }
                              if (status === "sanctioned" && offers.length === 0) {
                                setSanctioning(submission.id);
                                return;
                              }
                              const result = updateSubmissionStatus(
                                submission.id,
                                status,
                                session.user.id,
                              );
                              toast.show(
                                result.ok ? `Moved to ${titleCase(status)}` : (result.message ?? ""),
                                result.ok ? "good" : "bad",
                              );
                            }}
                          >
                            {titleCase(status)}
                          </Button>
                        ))}
                      </div>
                    )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {addOpen && <AddBankDialog caseId={caseId} onClose={() => setAddOpen(false)} />}

      <RejectDialog
        submissionId={rejecting}
        onClose={() => setRejecting(null)}
      />
      <SanctionDialog submissionId={sanctioning} onClose={() => setSanctioning(null)} />
    </div>
  );
}

/**
 * Add a bank to this case (Milestone 10, ADR-036).
 *
 * Replaces "Send to a bank", which was one flat dropdown of every branch in
 * the system and no recipients at all. The workflow the office actually
 * follows is:
 *
 *   Bank → Branch → primary banker → + Add Banker → …
 *
 * Two things about it are deliberate and easy to get wrong later.
 *
 * The bank is chosen BEFORE the branch, not derived after it. A flat branch
 * list is unusable once the catalogue has real depth — there are dozens of
 * Coimbatore branches and the user knows which bank they are talking to
 * before they know which branch.
 *
 * Recipients are a LIST with no fixed length. Multiple bankers are the norm:
 * the relationship manager, the credit manager who raises the query, and the
 * branch's shared mailbox so the file does not die when one person is on
 * leave. Catalogued contacts fill a row in one click; a typed-in address is
 * equally valid, because a workflow that only accepts catalogued addresses is
 * one people work around by keeping their own list.
 *
 * NOTHING HERE SENDS ANYTHING. This records who the file is addressed to.
 */
interface RecipientRow {
  key: string;
  email: string;
  name: string;
  designation: string;
  bankContactId?: string;
  kind: "to" | "cc";
}

let recipientKeySeq = 0;
const blankRecipient = (): RecipientRow => ({
  key: `r${++recipientKeySeq}`,
  email: "",
  name: "",
  designation: "",
  kind: "to",
});

function AddBankDialog({ caseId, onClose }: { caseId: string; onClose: () => void }): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const toast = useToast();

  const [institutionId, setInstitutionId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [submissionModeId, setSubmissionModeId] = useState("");
  const [primaryIndex, setPrimaryIndex] = useState(0);
  const [rows, setRows] = useState<RecipientRow[]>([blankRecipient()]);

  // On-panel lenders that still exist. A lender Amaze has stopped using is a
  // different fact from one that no longer exists (ADR-034), and neither
  // belongs in a picker for a file going out today.
  const institutions = db.organisations
    .filter((org) => org.roles.includes("lender") && org.isActive !== false)
    .filter((org) =>
      db.lenderProfiles.some(
        (profile) => profile.organisationId === org.id && profile.isOnPanel,
      ),
    )
    .slice()
    .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));

  const branches = db.organisations
    .filter((org) => org.roles.includes("branch") && org.parentOrganisationId === institutionId)
    .map((org) => ({
      org,
      extension: db.bankBranches.find((b) => b.organisationId === org.id),
    }))
    // A branch that is shut this month cannot take a file this month, so it
    // is not offered — the three-state detail stays on the branch itself for
    // whoever is reading the catalogue (@domain/lenders' isLodgeable).
    .filter(({ extension }) => extension?.operationalStatus === "operational")
    .sort((a, b) => a.org.canonicalName.localeCompare(b.org.canonicalName));

  // Contacts recorded against the chosen branch, plus the lender's contacts
  // who belong to no single branch — a regional manager is a legitimate
  // recipient and excluding them would send people back to their own list.
  const suggestions = db.bankContacts.filter(
    (contact) =>
      contact.isActive &&
      contact.workEmail !== undefined &&
      contact.institutionOrganisationId === institutionId &&
      (contact.branchOrganisationId === branchId || contact.branchOrganisationId === undefined),
  );

  const update = (index: number, patch: Partial<RecipientRow>): void =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const useContact = (index: number, contactId: string): void => {
    const contact = db.bankContacts.find((c) => c.id === contactId);
    if (!contact) {
      update(index, { bankContactId: undefined as unknown as string });
      return;
    }
    update(index, {
      bankContactId: contact.id,
      email: contact.workEmail ?? "",
      name: contactLabel(contact, db),
      designation:
        contact.designation ??
        db.lenderRelationshipRoles.find((role) => role.id === contact.relationshipRoleId)?.name ??
        "",
    });
  };

  return (
    <Modal open title="Add a bank to this file" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-ink-700">
          The branch is the counterparty, not the bank: a file physically goes to a specific place.
          The bankers below are who it is addressed to — the details are copied as they stand today,
          so editing the catalogue later will not rewrite this record.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Bank">
            <Select
              value={institutionId}
              onChange={(event) => {
                setInstitutionId(event.target.value);
                setBranchId("");
              }}
            >
              <option value="">Choose…</option>
              {institutions.map((institution) => (
                <option key={institution.id} value={institution.id}>
                  {institution.canonicalName}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Branch"
            hint={
              institutionId === ""
                ? "Choose a bank first."
                : branches.length === 0
                  ? "No open branch recorded. Add one under Lenders."
                  : undefined
            }
          >
            <Select
              value={branchId}
              disabled={institutionId === ""}
              onChange={(event) => setBranchId(event.target.value)}
            >
              <option value="">Choose…</option>
              {branches.map(({ org }) => (
                <option key={org.id} value={org.id}>
                  {org.canonicalName}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Bankers this file goes to</p>
          {rows.map((row, index) => (
            <div key={row.key} className="rounded-md bg-ink-50 p-2.5 ring-1 ring-ink-200">
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-ink-600">
                  <input
                    type="radio"
                    name="primary-banker"
                    checked={primaryIndex === index}
                    onChange={() => setPrimaryIndex(index)}
                  />
                  Primary
                </label>
                <Select
                  className="ml-auto"
                  value={row.kind}
                  onChange={(event) =>
                    update(index, { kind: event.target.value as "to" | "cc" })
                  }
                >
                  <option value="to">To</option>
                  <option value="cc">Copied</option>
                </Select>
                {rows.length > 1 && (
                  <Button
                    onClick={() => {
                      setRows((current) => current.filter((_, i) => i !== index));
                      setPrimaryIndex((current) =>
                        current >= index && current > 0 ? current - 1 : current,
                      );
                    }}
                  >
                    Remove
                  </Button>
                )}
              </div>

              {suggestions.length > 0 && (
                <Field label="From the catalogue" hint="Or type an address below.">
                  <Select
                    value={row.bankContactId ?? ""}
                    onChange={(event) => useContact(index, event.target.value)}
                  >
                    <option value="">— Type it in —</option>
                    {suggestions.map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contactLabel(contact, db)}
                        {contact.isPrimaryContact ? " (primary)" : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}

              <Field label="Email">
                <Input
                  value={row.email}
                  placeholder="manager.rspuram@bank.com"
                  onChange={(event) =>
                    update(index, {
                      email: event.target.value,
                      bankContactId: undefined as unknown as string,
                    })
                  }
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name" hint="Optional — a shared mailbox has none.">
                  <Input
                    value={row.name}
                    onChange={(event) => update(index, { name: event.target.value })}
                  />
                </Field>
                <Field label="Designation" hint="Optional.">
                  <Input
                    value={row.designation}
                    onChange={(event) => update(index, { designation: event.target.value })}
                  />
                </Field>
              </div>
            </div>
          ))}

          <Button onClick={() => setRows((current) => [...current, blankRecipient()])}>
            + Add Banker
          </Button>
        </div>

        <Field
          label="How it goes out"
          hint="Records intent only — AOS sends nothing. Managed under Master Data."
        >
          <Select
            value={submissionModeId}
            onChange={(event) => setSubmissionModeId(event.target.value)}
          >
            <option value="">— Not stated —</option>
            {db.submissionModes
              .filter((mode) => mode.isActive)
              .sort((a, b) => a.displayOrder - b.displayOrder)
              .map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.name}
                </option>
              ))}
          </Select>
        </Field>

        <p className="text-xs text-ink-500">
          It is created as <em>Not Submitted</em>: chosen, but not yet gone out. The case stage
          moves when you mark it Submitted.
        </p>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!branchId}
            onClick={() => {
              const result = createSubmission(
                {
                  caseId,
                  branchOrganisationId: branchId,
                  ...(submissionModeId ? { submissionModeId } : {}),
                  recipients: rows.map((row, index) => ({
                    email: row.email,
                    ...(row.name.trim() ? { name: row.name } : {}),
                    ...(row.designation.trim() ? { designation: row.designation } : {}),
                    ...(row.bankContactId ? { bankContactId: row.bankContactId } : {}),
                    kind: row.kind,
                    isPrimary: index === primaryIndex,
                  })),
                },
                session.user.id,
              );
              if (result.ok) {
                onClose();
                toast.show("Bank added. Mark it Submitted when the file physically goes out.");
                return;
              }
              toast.show(result.message ?? "Could not add the bank.", "bad");
            }}
          >
            Add Bank
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function RejectDialog({
  submissionId,
  onClose,
}: {
  submissionId: string | null;
  onClose: () => void;
}): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const toast = useToast();
  const [reasonId, setReasonId] = useState("");
  const [bankText, setBankText] = useState("");

  return (
    <Modal open={submissionId !== null} title="Record a rejection" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-ink-700">
          Two things, and both matter. The category is what reports group by; the bank's own wording
          is what proves the category was chosen honestly.
        </p>
        <Field label="Standardised category" hint="Required. This is the analysable half.">
          <Select value={reasonId} onChange={(event) => setReasonId(event.target.value)}>
            <option value="">Choose…</option>
            {[...db.rejectionReasons]
              .sort((a, b) => a.displayOrder - b.displayOrder)
              .map((reason) => (
                <option key={reason.id} value={reason.id}>
                  {reason.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field
          label="What the bank actually said"
          hint="Optional, verbatim. Five banks describe one refusal five ways."
        >
          <Textarea
            value={bankText}
            onChange={(event) => setBankText(event.target.value)}
            placeholder="FOIR exceeds 55% post proposed EMI"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => {
              if (!submissionId) return;
              const result = updateSubmissionStatus(submissionId, "rejected", session.user.id, {
                rejectionReasonId: reasonId,
                bankReasonText: bankText,
              });
              toast.show(result.ok ? "Rejection recorded" : (result.message ?? ""), result.ok ? "good" : "bad");
              if (result.ok) {
                setReasonId("");
                setBankText("");
                onClose();
              }
            }}
          >
            Record rejection
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function SanctionDialog({
  submissionId,
  onClose,
}: {
  submissionId: string | null;
  onClose: () => void;
}): ReactNode {
  const session = useSession();
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [rate, setRate] = useState("");
  const [years, setYears] = useState("20");

  return (
    <Modal open={submissionId !== null} title="Record the sanction" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-ink-700">
          A sanction needs an offer attached. "Sanctioned" with no amount, rate or tenure is not
          information — so the offer is captured here rather than left for later.
        </p>
        <Field label="Sanctioned amount">
          <Input
            type="number"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="3400000"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Rate %">
            <Input type="number" step="0.01" value={rate} onChange={(event) => setRate(event.target.value)} />
          </Field>
          <Field label="Tenure (years)">
            <Input type="number" value={years} onChange={(event) => setYears(event.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!amount}
            onClick={() => {
              if (!submissionId) return;
              const result = updateSubmissionStatus(submissionId, "sanctioned", session.user.id, {
                offer: {
                  amount: Number(amount),
                  rate: rate ? Number(rate) : undefined,
                  tenureMonths: years ? Number(years) * 12 : undefined,
                },
              });
              toast.show(
                result.ok ? "Sanction recorded — the case advanced" : (result.message ?? ""),
                result.ok ? "good" : "bad",
              );
              if (result.ok) {
                setAmount("");
                setRate("");
                onClose();
              }
            }}
          >
            Record sanction
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function Timeline({ caseId }: { caseId: string }): ReactNode {
  const db = useDatabase();
  const session = useSession();

  const events = db.events
    .filter((e) => e.caseId === caseId)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  return (
    <Card
      title="Everything that happened"
      subtitle={
        session.can("event.view", "own")
          ? "Append-only. Never edited, never deleted."
          : "A summary. The full audit log needs event.view."
      }
    >
      {events.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        <ol className="space-y-3">
          {events.map((event) => (
            <li key={event.id} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span
                  className={cx(
                    "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                    event.actorKind === "system" ? "bg-brand-500" : "bg-ink-300",
                  )}
                />
                <span className="w-px flex-1 bg-ink-100" />
              </div>
              <div className="min-w-0 flex-1 pb-1">
                <p className="text-sm">{event.summary}</p>
                <p className="text-xs text-ink-500">
                  {/* Two classes of actor, and the UI must distinguish them so
                      nobody wonders who moved their case (ADR-019). */}
                  {event.actorKind === "system"
                    ? "System"
                    : (db.users.find((u) => u.id === event.actorUserId)?.name ?? "Someone")}
                  {" · "}
                  {exactly(event.occurredAt)}
                  {event.causedBy && (
                    <span className="block italic">because {event.causedBy}</span>
                  )}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
