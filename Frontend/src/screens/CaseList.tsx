/**
 * Every case the signed-in employee may see.
 *
 * Stage 3B: the rows come from `GET /api/cases`, which applies the scope rule
 * in SQL. THE FILTERING IS NOT DONE HERE ANY MORE, and that is the change that
 * matters. The old version fetched every case in the browser's store and hid
 * the ones the user should not see — a filter anyone could step around by
 * opening devtools. Now a Telecaller's request returns their own cases and
 * nothing else; there is nothing on the wire to hide.
 *
 * The stage and owner selects still filter client-side, over the rows the
 * server already decided this person may have. Those are conveniences, not
 * boundaries.
 *
 * Document progress has left the table. It was `progressFor(caseId)` out of
 * the prototype store, and requirements have not migrated — a column computed
 * from data that no longer describes these cases would be a confident lie.
 * It returns with the requirements slice.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { CASE_STAGES, CASE_STAGE_LABELS, type CaseStage } from "@domain/case/stages.js";

import { useReference, useUsers } from "../api/catalogue.js";
import { useApiQuery } from "../api/hooks.js";
import type { ApiCase } from "../api/types.js";
import { lakhs, when } from "../lib.js";
import { useSession } from "../session.js";
import { Badge, Button, Card, Empty, Select, StageBadge, cx } from "../ui/index.js";

export function CaseList(): ReactNode {
  const session = useSession();
  const cases = useApiQuery<readonly ApiCase[]>("/cases");
  const reference = useReference();
  const users = useUsers();

  const [stage, setStage] = useState<CaseStage | "all" | "active">("active");
  const [owner, setOwner] = useState<string>("all");

  const seesEverything = session.can("case.read", "all");

  const filtered = useMemo(() => {
    return (cases.data ?? [])
      .filter((c) => {
        if (stage === "active") return c.stage !== "closed" && c.stage !== "lost";
        if (stage === "all") return true;
        return c.stage === stage;
      })
      .filter((c) => owner === "all" || c.ownerUserId === owner);
  }, [cases.data, stage, owner]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Cases</h1>
          <p className="mt-1 text-sm text-ink-500">
            {seesEverything
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

          {seesEverything && (
            <Select
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              className="w-48"
            >
              <option value="all">Any owner</option>
              {users.activeUsers.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.fullName}
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
        {cases.loading ? (
          <Empty>Loading cases…</Empty>
        ) : cases.error ? (
          <Empty>{cases.error.message}</Empty>
        ) : filtered.length === 0 ? (
          <Empty>
            {(cases.data ?? []).length === 0
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
                  <th className="px-4 py-2 font-medium">Stage</th>
                  <th className="px-4 py-2 font-medium">Owner</th>
                  <th className="px-4 py-2 font-medium">Opened</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {filtered.map((loanCase) => (
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
                      {loanCase.applicantId ? (
                        <Link
                          to={`/people/${loanCase.applicantId}`}
                          className="hover:underline"
                        >
                          {loanCase.applicantName}
                        </Link>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-ink-700">
                      {reference.productLabel(loanCase.loanProductId)}
                    </td>
                    <td className="tnum px-4 py-2 text-right">
                      {lakhs(loanCase.requestedAmount ?? undefined)}
                    </td>
                    <td className="px-4 py-2">
                      <StageBadge
                        stage={loanCase.stage}
                        label={CASE_STAGE_LABELS[loanCase.stage]}
                      />
                    </td>
                    <td className="px-4 py-2 text-ink-500">
                      {users.ownerName(loanCase.ownerUserId)}
                    </td>
                    <td className="px-4 py-2 text-ink-500">{when(loanCase.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
