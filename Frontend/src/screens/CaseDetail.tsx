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

import { useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";

import {
  CASE_STAGE_LABELS,
  LOST_REASONS,
  LOST_REASON_LABELS,
  type CaseStage,
  type LostReason,
} from "@domain/case/stages.js";
import { evaluateTransition } from "@domain/case/transitions.js";
import { financialYearOf, isFinancialYearScoped } from "@domain/requirements/financial-year.js";

import {
  acceptOffer,
  addFinancialYearRequirement,
  addNote,
  addParty,
  createSubmission,
  logCommunication,
  moveStage,
  progressFor,
  selectableFinancialYears,
  setHold,
  snapshotOf,
  updateSubmissionStatus,
  uploadDocument,
  verifyDocument,
  waiveRequirement,
} from "../fake/store.js";
import { useDatabase } from "../fake/useDatabase.js";
import type { CasePartyRole, Id, SubmissionStatus } from "../fake/types.js";
import type { FyGroup } from "./document-financial-years.js";
import { financialYearGroups } from "./document-financial-years.js";
import {
  bytes,
  exactly,
  lakhs,
  maskedPan,
  money,
  ownerName,
  panOf,
  partyName,
  primaryApplicant,
  primaryPhone,
  productLabel,
  titleCase,
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
  ProgressBar,
  Select,
  StageBadge,
  Textarea,
  cx,
  useToast,
} from "../ui/index.js";
import { OrganisationSearchField, PersonSearchField } from "../ui/pickers.js";

type Tab = "overview" | "documents" | "banks" | "timeline";

export function CaseDetail(): ReactNode {
  const { caseId = "" } = useParams();
  const db = useDatabase();
  const session = useSession();
  const [tab, setTab] = useState<Tab>("overview");

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
          This user holds <code>case.read</code> at <code>own</code> scope, and this case belongs to{" "}
          {ownerName(db, loanCase)}. The row is not hidden by the interface — it would not be
          returned by the database either.
        </p>
      </Card>
    );
  }

  const applicant = primaryApplicant(db, loanCase.id);
  const progress = progressFor(loanCase.id);

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "overview", label: "Overview" },
    {
      id: "documents",
      label: "Documents",
      count: progress.outstandingCount,
    },
    {
      id: "banks",
      label: "Banks",
      count: db.submissions.filter((s) => s.caseId === caseId).length,
    },
    { id: "timeline", label: "Timeline" },
  ];

  return (
    <div className="space-y-4">
      <CaseHeader caseId={caseId} />

      <div className="flex items-center gap-1 border-b border-ink-200">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            onClick={() => setTab(entry.id)}
            className={cx(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium",
              tab === entry.id
                ? "border-brand-600 text-ink-900"
                : "border-transparent text-ink-500 hover:text-ink-700",
            )}
          >
            {entry.label}
            {entry.count !== undefined && entry.count > 0 && (
              <span className="tnum rounded bg-ink-100 px-1.5 text-xs">{entry.count}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "overview" && <Overview caseId={caseId} />}
      {tab === "documents" && <Documents caseId={caseId} />}
      {tab === "banks" && <Banks caseId={caseId} />}
      {tab === "timeline" && <Timeline caseId={caseId} />}
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

  const loanCase = db.cases.find((c) => c.id === caseId);
  if (!loanCase) return null;

  const applicant = primaryApplicant(db, caseId);
  const progress = progressFor(caseId);
  const snapshot = snapshotOf(loanCase);

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
              {money(loanCase.requestedAmount)} · owner {ownerName(db, loanCase)}
            </p>
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
    </>
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
  const [note, setNote] = useState("");
  const [logOpen, setLogOpen] = useState(false);

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
                          {" · "}
                          {titleCase(employment.employmentType)}
                          {employment.monthlyIncome && ` · ${money(employment.monthlyIncome)}/mo`}
                        </>
                      )}
                    </p>
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
                </li>
              );
            })}
          </ul>
        </Card>

        {/* No empty section for a property that does not exist. Absence is
            silence (Principle #1). */}
        {caseProperties.length > 0 && (
          <Card title="Property">
            <ul className="divide-y divide-ink-100">
              {caseProperties.map((link) => {
                const property = db.properties.find((p) => p.id === link.propertyId);
                return (
                  <li key={link.id} className="py-2.5 first:pt-0 last:pb-0">
                    <p className="text-sm font-medium">
                      {[property?.buildingName, property?.doorNumber].filter(Boolean).join(" ") ||
                        "Property"}
                    </p>
                    <p className="text-xs text-ink-500">
                      {property?.locality}, {property?.city} · {property?.propertyType} ·{" "}
                      {lakhs(property?.estimatedValue)} · {titleCase(link.role)}
                    </p>
                  </li>
                );
              })}
            </ul>
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
            <p className="text-sm text-ink-500">
              This user does not hold <code>note.read</code>. Notes are customer content, not system
              structure.
            </p>
          )}
        </Card>
      </div>

      <AddPartyDialog open={addOpen} caseId={caseId} onClose={() => setAddOpen(false)} />
      <LogCallDialog open={logOpen} caseId={caseId} onClose={() => setLogOpen(false)} />
    </div>
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
  const [waiveReason, setWaiveReason] = useState("");
  const [addingYearFor, setAddingYearFor] = useState<FyGroup | null>(null);

  if (!session.can("document.read", "own")) {
    return (
      <Card title="Documents are not visible to this user">
        <p className="text-sm text-ink-700">
          This role holds no <code>document.read</code>. The customer's documents are content, not
          system structure — and a masked PAN column would protect nothing if the PAN card image
          were readable here.
        </p>
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

  const outstanding = due.filter((r) => r.status === "pending" || r.status === "received");
  const settled = due.filter((r) => ["verified", "waived", "not_applicable"].includes(r.status));
  const fyGroups = financialYearGroups(db, requirements);

  const onFileChosen = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    const requirementId = uploadingFor;
    setUploadingFor(null);
    event.target.value = "";
    if (!file || !requirementId) return;

    void file.arrayBuffer().then((buffer) => {
      void uploadDocument(
        requirementId,
        {
          name: file.name,
          size: file.size,
          bytes: new Uint8Array(buffer),
          ...(file.type ? { contentType: file.type } : {}),
        },
        session.user.id,
      ).then(() => {
        toast.show(`${file.name} uploaded. It still needs a human to verify it.`);
      });
    });
  };

  const Row = ({ requirementId }: { requirementId: string }): ReactNode => {
    const requirement = requirements.find((r) => r.id === requirementId);
    if (!requirement) return null;

    const type = db.documentTypes.find((t) => t.id === requirement.documentTypeId);
    const document = db.documents.find((d) => d.id === requirement.satisfiedByDocumentId);
    const subject = requirement.requiredOfCasePartyId
      ? partyName(db, requirement.requiredOfCasePartyId)
      : requirement.requiredOfCasePropertyId
        ? "Property"
        : "The case";

    const tone =
      requirement.status === "verified"
        ? "good"
        : requirement.status === "received"
          ? "info"
          : requirement.status === "waived"
            ? "warn"
            : requirement.status === "not_applicable"
              ? "neutral"
              : "neutral";

    return (
      <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 first:pt-0 last:pb-0">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {type?.name}
            {requirement.periodStart && ` · FY ${financialYearOf(new Date(requirement.periodStart)).label}`}
          </p>
          <p className="text-xs text-ink-500">
            {subject}
            {document && ` · ${document.fileName} · ${bytes(document.fileSizeBytes)}`}
            {requirement.status === "waived" && ` · waived: ${requirement.reason}`}
          </p>
        </div>

        <Badge tone={tone}>{titleCase(requirement.status)}</Badge>

        <div className="flex shrink-0 gap-1.5">
          {requirement.status === "pending" && session.can("document.upload", "own") && (
            <Button
              onClick={() => {
                setUploadingFor(requirement.id);
                fileInput.current?.click();
              }}
            >
              Upload
            </Button>
          )}
          {requirement.status === "received" && session.can("document.verify", "own") && (
            <Button
              variant="primary"
              onClick={() => {
                const result = verifyDocument(requirement.id, session.user.id);
                toast.show(result.ok ? "Verified" : (result.message ?? ""), result.ok ? "good" : "bad");
              }}
            >
              Verify
            </Button>
          )}
          {["pending", "received"].includes(requirement.status) &&
            session.can("requirement.waive", "own") && (
              <Button
                variant="ghost"
                onClick={() => {
                  setWaiveFor(requirement.id);
                  setWaiveReason("");
                }}
              >
                Waive
              </Button>
            )}
        </div>
      </li>
    );
  };

  return (
    <div className="space-y-6">
      <input ref={fileInput} type="file" className="hidden" onChange={onFileChosen} />

      <Card
        title="Still needed"
        subtitle={
          outstanding.length === 0
            ? "Nothing outstanding. This file is complete."
            : `${outstanding.length} outstanding · ${progress.percentComplete}% complete`
        }
      >
        {outstanding.length === 0 ? (
          <Empty>Nothing is missing before this file can go to a bank.</Empty>
        ) : (
          <ul className="divide-y divide-ink-100">
            {outstanding.map((requirement) => (
              <Row key={requirement.id} requirementId={requirement.id} />
            ))}
          </ul>
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
                      FY {label}
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
              const type = db.documentTypes.find((t) => t.id === requirement.documentTypeId);
              return (
                <li key={requirement.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                  <span className="flex-1 text-sm text-ink-700">{type?.name}</span>
                  <Badge>from {titleCase(requirement.applicableFromStage)}</Badge>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {settled.length > 0 && (
        <Card title="Settled" subtitle="Verified, waived, or no longer applicable">
          <ul className="divide-y divide-ink-100">
            {settled.map((requirement) => (
              <Row key={requirement.id} requirementId={requirement.id} />
            ))}
          </ul>
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
            <Button onClick={() => setWaiveFor(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!waiveFor) return;
                const result = waiveRequirement(waiveFor, waiveReason, session.user.id);
                toast.show(result.ok ? "Waived" : (result.message ?? ""), result.ok ? "good" : "bad");
                if (result.ok) setWaiveFor(null);
              }}
            >
              Waive
            </Button>
          </div>
        </div>
      </Modal>

      <AddFinancialYearDialog
        caseId={caseId}
        group={addingYearFor}
        onClose={() => setAddingYearFor(null)}
      />
    </div>
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
  const [branchId, setBranchId] = useState("");
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [sanctioning, setSanctioning] = useState<string | null>(null);

  const submissions = db.submissions.filter((s) => s.caseId === caseId);
  const branches = db.organisations.filter((o) => o.roles.includes("branch"));

  if (!session.can("submission.read", "own")) {
    return <Card title="Not visible to this user" />;
  }

  return (
    <div className="space-y-6">
      <Card
        title="Submissions"
        subtitle="Each bank moves independently. A case can be sanctioned at one and rejected at another — both are true."
        actions={
          session.can("submission.create", "own") && (
            <Button onClick={() => setAddOpen(true)}>Send to a bank</Button>
          )
        }
      >
        {submissions.length === 0 ? (
          <Empty>Not sent to any bank yet.</Empty>
        ) : (
          <ul className="divide-y divide-ink-100">
            {submissions.map((submission) => {
              const branch = db.organisations.find(
                (o) => o.id === submission.branchOrganisationId,
              );
              const offers = db.offers.filter((o) => o.submissionId === submission.id);
              const reason = db.rejectionReasons.find(
                (r) => r.id === submission.rejectionReasonId,
              );

              return (
                <li key={submission.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{branch?.canonicalName}</span>
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

      <Modal open={addOpen} title="Send this file to a bank" onClose={() => setAddOpen(false)}>
        <div className="space-y-3">
          <p className="text-sm text-ink-700">
            The branch is the counterparty, not the bank: a file goes to a specific place and a
            specific relationship manager works it.
          </p>
          <Field label="Branch">
            <Select value={branchId} onChange={(event) => setBranchId(event.target.value)}>
              <option value="">Choose…</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.canonicalName}
                </option>
              ))}
            </Select>
          </Field>
          <p className="text-xs text-ink-500">
            It is created as <em>Not Submitted</em>: chosen, but not yet gone out.
          </p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!branchId}
              onClick={() => {
                createSubmission(caseId, branchId, session.user.id);
                setBranchId("");
                setAddOpen(false);
                toast.show("Prepared. Mark it Submitted when the file physically goes out.");
              }}
            >
              Prepare
            </Button>
          </div>
        </div>
      </Modal>

      <RejectDialog
        submissionId={rejecting}
        onClose={() => setRejecting(null)}
      />
      <SanctionDialog submissionId={sanctioning} onClose={() => setSanctioning(null)} />
    </div>
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
