import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { CASE_STAGES, CASE_STAGE_LABELS, type CaseStage } from "@domain/case/stages.js";

import { progressFor } from "../fake/store.js";
import { useDatabase } from "../fake/useDatabase.js";
import { lakhs, ownerName, primaryApplicant, productLabel, when } from "../lib.js";
import { useSession } from "../session.js";
import { Badge, Button, Card, Empty, ProgressBar, Select, StageBadge, cx } from "../ui/index.js";

export function CaseList(): ReactNode {
  const db = useDatabase();
  const session = useSession();

  const [stage, setStage] = useState<CaseStage | "all" | "active">("active");
  const [owner, setOwner] = useState<string>("all");

  const scoped = useMemo(() => {
    if (session.can("case.read", "all")) return db.cases;
    if (session.can("case.read", "own")) {
      return db.cases.filter((c) => c.ownerUserId === session.user.id);
    }
    return [];
  }, [db.cases, session]);

  const filtered = useMemo(() => {
    return scoped
      .filter((c) => {
        if (stage === "active") return c.stage !== "closed" && c.stage !== "lost";
        if (stage === "all") return true;
        return c.stage === stage;
      })
      .filter((c) => owner === "all" || c.ownerUserId === owner)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [scoped, stage, owner]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Cases</h1>
          <p className="mt-1 text-sm text-ink-500">
            {session.can("case.read", "all")
              ? "Every case."
              : "Cases you own. A colleague's cases are not yours to browse."}
          </p>
        </div>

        <div className="flex items-end gap-2">
          <Select
            value={stage}
            onChange={(event) => setStage(event.target.value as CaseStage | "all" | "active")}
            className="w-48"
          >
            {/* Early-stage cases are numerous and mostly empty (ADR-008), so the
                default hides the dead ones rather than making the list noise. */}
            <option value="active">Active only</option>
            <option value="all">Everything, including lost</option>
            {CASE_STAGES.map((value) => (
              <option key={value} value={value}>
                {CASE_STAGE_LABELS[value]}
              </option>
            ))}
          </Select>

          {session.can("case.read", "all") && (
            <Select
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              className="w-48"
            >
              <option value="all">Any owner</option>
              {db.users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </Select>
          )}

          {session.can("case.create", "all") && (
            <Link to="/cases/new">
              <Button variant="primary">New case</Button>
            </Link>
          )}
        </div>
      </div>

      <Card>
        {filtered.length === 0 ? (
          <Empty>
            {scoped.length === 0
              ? "You cannot see any cases with the permissions this user holds."
              : "No cases match this filter."}
          </Empty>
        ) : (
          <div className="-m-4 overflow-x-auto">
            <table className="w-full min-w-3xl text-sm">
              <thead>
                <tr className="border-b border-ink-100 text-left text-xs text-ink-500">
                  <th className="px-4 py-2 font-medium">Case</th>
                  <th className="px-4 py-2 font-medium">Applicant</th>
                  <th className="px-4 py-2 font-medium">Product</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                  <th className="px-4 py-2 font-medium">Documents</th>
                  <th className="px-4 py-2 font-medium">Stage</th>
                  <th className="px-4 py-2 font-medium">Owner</th>
                  <th className="px-4 py-2 font-medium">Opened</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {filtered.map((loanCase) => {
                  const applicant = primaryApplicant(db, loanCase.id);
                  const progress = progressFor(loanCase.id);
                  return (
                    <tr
                      key={loanCase.id}
                      className={cx("hover:bg-ink-50", loanCase.isOnHold && "opacity-70")}
                    >
                      <td className="px-4 py-2">
                        <Link
                          to={`/cases/${loanCase.id}`}
                          className="tnum font-medium hover:underline"
                        >
                          {loanCase.caseNumber}
                        </Link>
                        {loanCase.isOnHold && (
                          <span className="ml-2">
                            <Badge tone="warn">Hold</Badge>
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {applicant ? (
                          <Link to={`/people/${applicant.id}`} className="hover:underline">
                            {applicant.fullName}
                          </Link>
                        ) : (
                          <span className="text-ink-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-ink-700">{productLabel(db, loanCase)}</td>
                      <td className="tnum px-4 py-2 text-right">
                        {lakhs(loanCase.requestedAmount)}
                      </td>
                      <td className="w-40 px-4 py-2">
                        <ProgressBar
                          percent={progress.percentComplete}
                          applicable={progress.applicableCount}
                        />
                      </td>
                      <td className="px-4 py-2">
                        <StageBadge
                          stage={loanCase.stage}
                          label={CASE_STAGE_LABELS[loanCase.stage]}
                        />
                      </td>
                      <td className="px-4 py-2 text-ink-500">{ownerName(db, loanCase)}</td>
                      <td className="px-4 py-2 text-ink-500">{when(loanCase.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
