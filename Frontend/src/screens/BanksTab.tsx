/**
 * The Banks tab — Stage 3D.
 *
 * Add a bank branch, choose the verified documents that belong with it,
 * review the emails AOS is about to send, and send them through the real
 * Gmail-backed mail backend (`Backend/mail-client.ts` -> `mail-server.mjs`).
 * A case only becomes Submitted once that send actually succeeds — the
 * server does that (`Backend/submissions.ts`'s `finalizeIfFullySent`), never
 * this screen; this screen only shows what the server decided.
 *
 * Split out of `CaseDetail.tsx` because the send flow is a three-step modal
 * with its own state machine, not because the patterns differ — every piece
 * here mirrors `DocumentsTab`/`RequirementRow`: `useApiQuery` for reads,
 * `useMutation` + `useToast` for writes, `onChanged` to refresh both this
 * tab and the case header after a write that can move the case's stage.
 */

import { useState, type ReactNode } from "react";

import { api } from "../api/client.js";
import { useApiQuery, useMutation } from "../api/hooks.js";
import { useLenders } from "../api/lenders.js";
import type {
  ApiCase,
  ApiLenderBranch,
  ApiPackage,
  ApiPreparedPackage,
  ApiSendableDocument,
  ApiSendResult,
  ApiSubmission,
  SubmissionStatus,
} from "../api/types.js";
import { bytes, when } from "../lib.js";
import { useSession } from "../session.js";
import { Badge, Button, Card, Empty, Field, Input, Modal, PermissionCode, Select, cx, useToast } from "../ui/index.js";

const SUBMISSION_STATUS_LABELS: Record<SubmissionStatus, string> = {
  not_submitted: "Draft",
  submitted: "Submitted",
  under_process: "Under process",
  query_raised: "Query raised",
  eligibility_received: "Eligibility received",
  sanctioned: "Sanctioned",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  disbursed: "Disbursed",
};

function statusTone(status: SubmissionStatus): "neutral" | "info" | "warn" | "good" | "bad" {
  switch (status) {
    case "not_submitted":
      return "neutral";
    case "rejected":
      return "bad";
    case "withdrawn":
      return "neutral";
    case "sanctioned":
    case "disbursed":
      return "good";
    default:
      return "info";
  }
}

/** Whether the case has anything actually gone out to a bank yet — the same
 * fact `hasLiveSubmission` guards in `@domain/case/transitions.ts`, read here
 * only to decide what the tab shows, never to decide what is allowed. */
function hasLiveSubmission(submissions: readonly ApiSubmission[]): boolean {
  return submissions.some((s) => s.status !== "not_submitted");
}

export function BanksTab({
  loanCase,
  onCaseChanged,
}: {
  loanCase: ApiCase;
  onCaseChanged: () => void;
}): ReactNode {
  const query = useApiQuery<readonly ApiSubmission[]>(`/cases/${loanCase.id}/submissions`);
  const session = useSession();
  const [addBankOpen, setAddBankOpen] = useState(false);
  const [sendingFor, setSendingFor] = useState<ApiSubmission | null>(null);

  const mayCreate = session.canActOnCase(loanCase.ownerUserId, "submission.create");

  const refetchAll = (): void => {
    query.refetch();
    // A successful send can move the case to Submitted (ADR-019, Stage 3D) —
    // the header above the tabs must show that without a manual reload.
    onCaseChanged();
  };

  if (query.loading) return <Empty>Loading submissions…</Empty>;
  if (query.error) {
    return (
      <Card title="Banks">
        <p className="text-sm text-ink-700">{query.error.message}</p>
        {query.error.isRefusal && <PermissionCode code="submission.read" />}
      </Card>
    );
  }

  const submissions = query.data ?? [];
  const readyWithNothingSent = loanCase.stage === "ready_for_submission" && !hasLiveSubmission(submissions);

  return (
    <div className="space-y-4">
      {readyWithNothingSent && (
        <div className="rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-900 ring-1 ring-sky-200">
          This case is ready for submission. Add a bank below and send its verified documents —
          the case moves to Submitted automatically once a send succeeds.
        </div>
      )}

      <Card
        title="Banks"
        actions={
          mayCreate && (
            <Button variant="primary" onClick={() => setAddBankOpen(true)}>
              Add bank
            </Button>
          )
        }
      >
        {submissions.length === 0 ? (
          <Empty>No bank has been added to this case yet.</Empty>
        ) : (
          <div className="space-y-3">
            {submissions.map((submission) => (
              <SubmissionCard
                key={submission.id}
                loanCase={loanCase}
                submission={submission}
                mayCreate={mayCreate}
                onSend={() => setSendingFor(submission)}
                onChanged={refetchAll}
              />
            ))}
          </div>
        )}
      </Card>

      {addBankOpen && (
        <AddBankModal
          loanCase={loanCase}
          onClose={() => setAddBankOpen(false)}
          onChanged={() => {
            setAddBankOpen(false);
            refetchAll();
          }}
        />
      )}

      {sendingFor && (
        <SendPackageModal
          loanCase={loanCase}
          submission={sendingFor}
          onClose={() => setSendingFor(null)}
          onChanged={() => {
            setSendingFor(null);
            refetchAll();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One bank on the case
// ---------------------------------------------------------------------------

function SubmissionCard({
  loanCase,
  submission,
  mayCreate,
  onSend,
  onChanged,
}: {
  loanCase: ApiCase;
  submission: ApiSubmission;
  mayCreate: boolean;
  onSend: () => void;
  onChanged: () => void;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const packagesQuery = useApiQuery<readonly ApiPackage[]>(
    expanded ? `/cases/${loanCase.id}/submissions/${submission.id}/packages` : null,
  );

  return (
    <div className="rounded-md ring-1 ring-ink-100">
      <div className="flex flex-wrap items-start justify-between gap-3 p-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink-900">{submission.counterparty}</p>
          <p className="mt-0.5 text-xs text-ink-500">
            {submission.recipients.length === 0
              ? "No bankers addressed"
              : submission.recipients
                  .map((r) => r.name ?? r.email)
                  .join(", ")}
          </p>
          <p className="mt-0.5 text-xs text-ink-400">Added {when(submission.createdAt)}</p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={statusTone(submission.status)}>{SUBMISSION_STATUS_LABELS[submission.status]}</Badge>
          {submission.latestPackage && (
            <Badge tone={packageTone(submission.latestPackage.status)}>
              {packageStatusLabel(submission.latestPackage.status)}
            </Badge>
          )}
          {mayCreate && submission.status === "not_submitted" && (
            <Button variant="primary" onClick={onSend}>
              Send documents
            </Button>
          )}
          {submission.latestPackage && (
            <Button variant="ghost" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "Hide history" : "Show history"}
            </Button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-ink-100 p-3">
          {packagesQuery.loading && <Empty>Loading packages…</Empty>}
          {packagesQuery.data && (
            <PackagesList
              loanCase={loanCase}
              submission={submission}
              packages={packagesQuery.data}
              mayCreate={mayCreate}
              onChanged={onChanged}
            />
          )}
        </div>
      )}
    </div>
  );
}

function packageTone(status: string): "neutral" | "info" | "warn" | "good" | "bad" {
  switch (status) {
    case "sent":
      return "good";
    case "partially_sent":
      return "warn";
    case "failed":
      return "bad";
    default:
      return "neutral";
  }
}

function packageStatusLabel(status: string): string {
  switch (status) {
    case "sent":
      return "Documents sent";
    case "partially_sent":
      return "Partially sent";
    case "failed":
      return "Send failed";
    default:
      return "Sending…";
  }
}

function PackagesList({
  loanCase,
  submission,
  packages,
  mayCreate,
  onChanged,
}: {
  loanCase: ApiCase;
  submission: ApiSubmission;
  packages: readonly ApiPackage[];
  mayCreate: boolean;
  onChanged: () => void;
}): ReactNode {
  const retry = useMutation();
  const toast = useToast();

  return (
    <div className="space-y-3">
      {packages.map((pkg) => (
        <div key={pkg.id} className="rounded-md bg-ink-50 p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-ink-700">
              {packageStatusLabel(pkg.status)} · {pkg.documentCount} document{pkg.documentCount === 1 ? "" : "s"} in{" "}
              {pkg.emailCount} email{pkg.emailCount === 1 ? "" : "s"} · {when(pkg.initiatedAt)}
            </p>
            {mayCreate && pkg.status === "failed" && (
              <Button
                disabled={retry.pending}
                onClick={async () => {
                  const result = await retry.run(() =>
                    api<ApiSendResult>(
                      `/cases/${loanCase.id}/submissions/${submission.id}/packages/${pkg.id}/retry`,
                      { method: "POST" },
                    ),
                  );
                  if (result) {
                    toast.show(result.message, result.failedCount === 0 ? "good" : "bad");
                    onChanged();
                  }
                }}
              >
                Retry failed emails
              </Button>
            )}
          </div>
          {retry.error && (
            <p className="mt-1 text-xs text-red-700" role="alert">
              {retry.error}
            </p>
          )}
          <ul className="mt-1.5 space-y-0.5">
            {pkg.emails.map((email) => (
              <li key={email.id} className="flex items-center justify-between gap-2 text-xs text-ink-600">
                <span className="truncate">{email.subject}</span>
                <Badge tone={email.status === "sent" ? "good" : email.status === "failed" ? "bad" : "neutral"}>
                  {email.status === "sent" ? "Sent" : email.status === "failed" ? "Failed" : "Pending"}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add bank
// ---------------------------------------------------------------------------

interface RecipientDraft {
  email: string;
  name: string;
  designation: string;
  kind: "to" | "cc";
  isPrimary: boolean;
}

function emptyRecipient(): RecipientDraft {
  return { email: "", name: "", designation: "", kind: "to", isPrimary: false };
}

function AddBankModal({
  loanCase,
  onClose,
  onChanged,
}: {
  loanCase: ApiCase;
  onClose: () => void;
  onChanged: () => void;
}): ReactNode {
  const lenders = useLenders();
  const mutation = useMutation();
  const [institutionId, setInstitutionId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [recipients, setRecipients] = useState<RecipientDraft[]>([emptyRecipient()]);

  const institution = lenders.lenders.find((l) => l.id === institutionId);
  const branches: readonly ApiLenderBranch[] = institution?.branches ?? [];

  const updateRecipient = (index: number, patch: Partial<RecipientDraft>): void => {
    setRecipients((current) => current.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  return (
    <Modal open title="Add bank" onClose={onClose} size="wide">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bank">
            <Select
              value={institutionId}
              onChange={(event) => {
                setInstitutionId(event.target.value);
                setBranchId("");
              }}
            >
              <option value="">Choose a bank…</option>
              {lenders.lenders.map((lender) => (
                <option key={lender.id} value={lender.id}>
                  {lender.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Branch">
            <Select value={branchId} onChange={(event) => setBranchId(event.target.value)} disabled={!institutionId}>
              <option value="">Choose a branch…</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                  {branch.city ? ` — ${branch.city}` : ""}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Bankers this file goes to" hint="At least one address is required.">
          <div className="space-y-2">
            {recipients.map((recipient, index) => (
              <div key={index} className="flex flex-wrap items-center gap-2">
                <Input
                  className="w-56"
                  placeholder="Email"
                  value={recipient.email}
                  onChange={(event) => updateRecipient(index, { email: event.target.value })}
                />
                <Input
                  className="w-40"
                  placeholder="Name (optional)"
                  value={recipient.name}
                  onChange={(event) => updateRecipient(index, { name: event.target.value })}
                />
                <Select
                  className="w-24"
                  value={recipient.kind}
                  onChange={(event) => updateRecipient(index, { kind: event.target.value as "to" | "cc" })}
                >
                  <option value="to">To</option>
                  <option value="cc">Cc</option>
                </Select>
                <label className="flex items-center gap-1 text-xs text-ink-600">
                  <input
                    type="checkbox"
                    checked={recipient.isPrimary}
                    onChange={(event) =>
                      setRecipients((current) =>
                        current.map((r, i) => ({ ...r, isPrimary: i === index ? event.target.checked : false })),
                      )
                    }
                  />
                  Primary
                </label>
                <Button
                  variant="ghost"
                  onClick={() => setRecipients((current) => current.filter((_, i) => i !== index))}
                  disabled={recipients.length === 1}
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button variant="ghost" onClick={() => setRecipients((current) => [...current, emptyRecipient()])}>
              + Add banker
            </Button>
          </div>
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
            disabled={mutation.pending || !branchId || recipients.every((r) => r.email.trim() === "")}
            onClick={async () => {
              const result = await mutation.run(() =>
                api<ApiSubmission>(`/cases/${loanCase.id}/submissions`, {
                  method: "POST",
                  body: {
                    branchOrganisationId: branchId,
                    recipients: recipients
                      .filter((r) => r.email.trim() !== "")
                      .map((r) => ({
                        email: r.email.trim(),
                        ...(r.name.trim() ? { name: r.name.trim() } : {}),
                        ...(r.designation.trim() ? { designation: r.designation.trim() } : {}),
                        kind: r.kind,
                        isPrimary: r.isPrimary,
                      })),
                  },
                }),
              );
              if (result) onChanged();
            }}
          >
            Add bank
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Send documents — select, review, send
// ---------------------------------------------------------------------------

function SendPackageModal({
  loanCase,
  submission,
  onClose,
  onChanged,
}: {
  loanCase: ApiCase;
  submission: ApiSubmission;
  onClose: () => void;
  onChanged: () => void;
}): ReactNode {
  const [step, setStep] = useState<"select" | "review">("select");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prepared, setPrepared] = useState<ApiPreparedPackage | null>(null);
  const toast = useToast();

  const docsQuery = useApiQuery<readonly ApiSendableDocument[]>(
    `/cases/${loanCase.id}/submissions/${submission.id}/sendable-documents`,
  );
  const prepareMutation = useMutation();
  const sendMutation = useMutation();

  const toggle = (documentId: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(documentId)) next.delete(documentId);
      else next.add(documentId);
      return next;
    });
  };

  return (
    <Modal open title={`Send documents — ${submission.counterparty}`} onClose={onClose} size="wide">
      {step === "select" && (
        <div className="space-y-3">
          {docsQuery.loading && <Empty>Loading verified documents…</Empty>}
          {docsQuery.error && <p className="text-sm text-ink-700">{docsQuery.error.message}</p>}
          {docsQuery.data && docsQuery.data.length === 0 && (
            <Empty>No verified documents are available to send yet.</Empty>
          )}
          {docsQuery.data && docsQuery.data.length > 0 && (
            <>
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() =>
                    setSelected(
                      new Set(docsQuery.data!.filter((d) => !d.blockedBecause).map((d) => d.documentId)),
                    )
                  }
                >
                  Select all verified
                </Button>
                <Button variant="ghost" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </div>
              <div className="max-h-96 divide-y divide-ink-100 overflow-y-auto">
                {docsQuery.data.map((document) => (
                  <label
                    key={document.documentId}
                    className={cx(
                      "flex items-center justify-between gap-3 py-2",
                      document.blockedBecause && "opacity-60",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        disabled={!!document.blockedBecause}
                        checked={selected.has(document.documentId)}
                        onChange={() => toggle(document.documentId)}
                      />
                      <span className="text-sm text-ink-900">{document.label}</span>
                    </span>
                    <span className="text-xs text-ink-500">
                      {document.blockedBecause ?? bytes(document.fileSizeBytes)}
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}

          {prepareMutation.error && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
              {prepareMutation.error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={prepareMutation.pending || selected.size === 0}
              onClick={async () => {
                const result = await prepareMutation.run(() =>
                  api<ApiPreparedPackage>(
                    `/cases/${loanCase.id}/submissions/${submission.id}/package/prepare`,
                    { method: "POST", body: { documentIds: [...selected] } },
                  ),
                );
                if (result) {
                  setPrepared(result);
                  setStep("review");
                }
              }}
            >
              Review
            </Button>
          </div>
        </div>
      )}

      {step === "review" && prepared && (
        <div className="space-y-3">
          <p className="text-sm text-ink-700">
            Sending as <strong>{prepared.plan.sender.name}</strong> ({prepared.plan.sender.address}) to{" "}
            {prepared.plan.to.map((r) => r.name ?? r.email).join(", ")}
            {prepared.plan.cc.length > 0 && <> · cc {prepared.plan.cc.map((r) => r.name ?? r.email).join(", ")}</>}
          </p>

          <div className="max-h-96 space-y-3 overflow-y-auto">
            {prepared.plan.emails.map((email) => (
              <div key={email.sequence} className="rounded-md bg-ink-50 p-3">
                <p className="text-xs font-semibold text-ink-900">{email.subject}</p>
                <p className="mt-1 text-xs text-ink-500">
                  {email.documents.length} attachment{email.documents.length === 1 ? "" : "s"} ·{" "}
                  {bytes(email.totalBytes)}
                </p>
                <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs text-ink-700">
                  {email.body}
                </pre>
              </div>
            ))}
          </div>

          {sendMutation.error && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
              {sendMutation.error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setStep("select")} disabled={sendMutation.pending}>
              Back
            </Button>
            <Button
              variant="primary"
              disabled={sendMutation.pending}
              onClick={async () => {
                const result = await sendMutation.run(() =>
                  api<ApiSendResult>(`/cases/${loanCase.id}/submissions/${submission.id}/package/send`, {
                    method: "POST",
                    body: { documentIds: [...selected], fingerprint: prepared.fingerprint },
                  }),
                );
                if (result) {
                  toast.show(result.message, result.failedCount === 0 ? "good" : "bad");
                  onChanged();
                }
              }}
            >
              {sendMutation.pending ? "Sending…" : "Send documents"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
