/**
 * A person, across every case.
 *
 * This screen is where "information is entered once" becomes visible: one
 * person, every case they have ever been on in any role, and their documents on
 * file — because a document belongs to the person, not to the loan application
 * that referenced it (ADR-007).
 */

import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";

import { CASE_STAGE_LABELS } from "@domain/case/stages.js";

import { useDatabase } from "../fake/useDatabase.js";
import type { CaseParty } from "../fake/types.js";
import {
  bytes,
  casesForPerson,
  lakhs,
  maskedPan,
  money,
  panOf,
  primaryPhone,
  productLabel,
  titleCase,
  when,
} from "../lib.js";
import { useSession } from "../session.js";
import { Badge, Card, Empty, StageBadge } from "../ui/index.js";

export function PersonProfile(): ReactNode {
  const { personId = "" } = useParams();
  const db = useDatabase();
  const session = useSession();

  const person = db.people.find((p) => p.id === personId);
  if (!person) return <Empty>Person not found.</Empty>;

  const cases = casesForPerson(db, person.id);
  const documents = db.documents.filter((d) => d.personId === person.id);
  const employment = db.employments.find((e) => e.personId === person.id && e.isCurrent);
  const employer = db.organisations.find((o) => o.id === employment?.organisationId);
  const communications = db.communications
    .filter((c) => c.personId === person.id)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  const roleOn = (caseId: string): CaseParty | undefined =>
    db.caseParties.find((p) => p.caseId === caseId && p.personId === person.id && !p.removedAt);

  // People who share a phone number. Usually a family phone; occasionally a
  // recycled one. Either way it is worth showing rather than silently fusing.
  const sharedPhone = db.people.filter(
    (other) =>
      other.id !== person.id &&
      other.identifiers.some((a) =>
        person.identifiers.some(
          (b) => b.type === "phone" && a.type === "phone" && a.value === b.value,
        ),
      ),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{person.fullName}</h1>
        <p className="tnum mt-1 text-sm text-ink-500">
          {primaryPhone(person) ?? "No number"}
          {" · "}
          {session.can("identifier.view_full", "all")
            ? (panOf(person) ?? "No PAN")
            : (maskedPan(person) ?? "No PAN")}
          {person.locality && ` · ${person.locality}, ${person.city}`}
        </p>
        {person.aliases.length > 0 && (
          <p className="mt-1 text-xs text-ink-500">
            Also known as {person.aliases.map((alias) => `"${alias}"`).join(", ")} — every spelling
            stays searchable, because that is what somebody will type next time.
          </p>
        )}
        {!session.can("identifier.view_full", "all") && (
          <p className="mt-1 text-xs text-ink-400">
            PAN is masked. This user does not hold <code>identifier.view_full</code>.
          </p>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card
            title={`${cases.length} case${cases.length === 1 ? "" : "s"}`}
            subtitle="Every role, every year. This is the question AOS exists to answer."
          >
            {cases.length === 0 ? (
              <Empty>No cases yet.</Empty>
            ) : (
              <ul className="divide-y divide-ink-100">
                {cases
                  .slice()
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .map((loanCase) => (
                    <li key={loanCase.id} className="py-2.5 first:pt-0 last:pb-0">
                      <Link
                        to={`/cases/${loanCase.id}`}
                        className="flex flex-wrap items-center gap-2 hover:underline"
                      >
                        <span className="tnum text-sm font-medium">{loanCase.caseNumber}</span>
                        <Badge>{titleCase(roleOn(loanCase.id)?.role ?? "party")}</Badge>
                        <span className="text-sm text-ink-700">{productLabel(db, loanCase)}</span>
                        <span className="tnum text-sm text-ink-500">
                          {lakhs(loanCase.requestedAmount)}
                        </span>
                        <span className="ml-auto">
                          <StageBadge
                            stage={loanCase.stage}
                            label={CASE_STAGE_LABELS[loanCase.stage]}
                          />
                        </span>
                      </Link>
                      <p className="mt-0.5 text-xs text-ink-500">
                        Opened {when(loanCase.createdAt)}
                      </p>
                    </li>
                  ))}
              </ul>
            )}
          </Card>

          {session.can("communication.read", "own") && (
            <Card
              title="Every conversation"
              subtitle="Across all their cases — a person's history is theirs, not a case's"
            >
              {communications.length === 0 ? (
                <Empty>Nothing logged.</Empty>
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
          )}
        </div>

        <div className="space-y-6">
          {employment && employer && (
            <Card title="Employment">
              <p className="text-sm font-medium">{employer.canonicalName}</p>
              <p className="text-xs text-ink-500">
                {employment.designation} · {titleCase(employment.employmentType)}
              </p>
              {employment.monthlyIncome && (
                <p className="tnum mt-1 text-sm">{money(employment.monthlyIncome)} / month</p>
              )}
              <p className="mt-2 border-t border-ink-100 pt-2 text-xs text-ink-500">
                Employment type drives which income documents this person's cases ask for.
              </p>
            </Card>
          )}

          {session.can("document.read", "own") && (
            <Card
              title="Documents on file"
              subtitle="Owned by the person, reused by every case"
            >
              {documents.length === 0 ? (
                <Empty>Nothing on file.</Empty>
              ) : (
                <ul className="space-y-2">
                  {documents.map((document) => {
                    const type = db.documentTypes.find((t) => t.id === document.documentTypeId);
                    return (
                      <li key={document.id} className="flex items-start gap-2">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{type?.name}</span>
                          <span className="block truncate text-xs text-ink-500">
                            {document.fileName} · {bytes(document.fileSizeBytes)}
                          </span>
                        </span>
                        <Badge tone={document.verifiedAt ? "good" : "info"}>
                          {document.verifiedAt ? "Verified" : "Unverified"}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          )}

          {sharedPhone.length > 0 && (
            <Card title="Shares a phone number">
              <ul className="space-y-1.5">
                {sharedPhone.map((other) => (
                  <li key={other.id}>
                    <Link to={`/people/${other.id}`} className="text-sm hover:underline">
                      {other.fullName}
                    </Link>
                  </li>
                ))}
              </ul>
              <p className="mt-2 border-t border-ink-100 pt-2 text-xs text-ink-500">
                Deliberately two records. A number is evidence, not identity: numbers are shared and
                recycled, and fusing these two would attach one person's history to another's.
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
