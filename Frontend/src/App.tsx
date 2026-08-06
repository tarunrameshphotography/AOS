import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";

import { ROLE_LABELS, type Role } from "@domain/permissions/index.js";

import { resetDatabase } from "./fake/store.js";
import { useDatabase } from "./fake/useDatabase.js";
import { search } from "./lib.js";
import { CaseDetail } from "./screens/CaseDetail.js";
import { CaseList } from "./screens/CaseList.js";
import { MasterData } from "./screens/MasterData.js";
import { NewCase } from "./screens/NewCase.js";
import { PersonProfile } from "./screens/PersonProfile.js";
import { WorkspaceHome } from "./screens/WorkspaceHome.js";
import {
  WORKSPACE_LABELS,
  WORKSPACE_QUESTIONS,
  WORKSPACES,
  useSession,
  type Workspace,
} from "./session.js";
import { Badge, Button, cx } from "./ui/index.js";

export function App(): ReactNode {
  return (
    <div className="flex min-h-full flex-col">
      <TopBar />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        <Routes>
          <Route path="/" element={<WorkspaceHome />} />
          <Route path="/cases" element={<CaseList />} />
          <Route path="/cases/new" element={<NewCase />} />
          <Route path="/cases/:caseId" element={<CaseDetail />} />
          <Route path="/people/:personId" element={<PersonProfile />} />
          <Route path="/admin/master-data" element={<MasterData />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <PrototypeFooter />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top bar: identity, workspace, one search box
// ---------------------------------------------------------------------------

function TopBar(): ReactNode {
  const session = useSession();

  return (
    <header className="sticky top-0 z-40 border-b border-ink-200 bg-white">
      <div className="mx-auto flex w-full max-w-7xl items-center gap-4 px-4 py-2.5">
        <Link to="/" className="flex shrink-0 items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded bg-brand-600 text-xs font-bold text-white">
            AL
          </span>
          <span className="text-sm font-semibold tracking-tight">AOS</span>
        </Link>

        <GlobalSearch />

        <nav className="ml-auto flex shrink-0 items-center gap-1">
          <NavLink
            to="/cases"
            className={({ isActive }) =>
              cx(
                "rounded-md px-3 py-1.5 text-sm font-medium",
                isActive ? "bg-ink-100 text-ink-900" : "text-ink-700 hover:bg-ink-50",
              )
            }
          >
            Cases
          </NavLink>
          {session.can("master_data.read", "all") && (
            <NavLink
              to="/admin/master-data"
              className={({ isActive }) =>
                cx(
                  "rounded-md px-3 py-1.5 text-sm font-medium",
                  isActive ? "bg-ink-100 text-ink-900" : "text-ink-700 hover:bg-ink-50",
                )
              }
            >
              Master Data
            </NavLink>
          )}
          {session.can("case.create", "all") && (
            <Link to="/cases/new">
              <Button variant="primary">New case</Button>
            </Link>
          )}
        </nav>

        <UserSwitcher />
      </div>

      <WorkspaceTabs />
    </header>
  );
}

/**
 * One search box. Not a person search and a case search and a document search —
 * one box, mixed results, grouped by type.
 */
function GlobalSearch(): ReactNode {
  const db = useDatabase();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  const hits = useMemo(() => search(db, query).slice(0, 8), [db, query]);

  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const go = (hit: (typeof hits)[number]): void => {
    setOpen(false);
    setQuery("");
    if (hit.kind === "case") navigate(`/cases/${hit.id}`);
    else if (hit.kind === "person") navigate(`/people/${hit.id}`);
  };

  return (
    <div ref={container} className="relative w-full max-w-md">
      <input
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Ravi · 9843 · Anna Nagar · IIFL · AL-2026-00041"
        className="w-full rounded-md bg-ink-50 px-3 py-1.5 text-sm ring-1 ring-ink-200 focus:bg-white focus:ring-2 focus:ring-brand-500 focus:outline-none"
      />

      {open && query.trim().length >= 2 && (
        <div className="absolute top-full left-0 mt-1 w-full overflow-hidden rounded-lg bg-white shadow-lg ring-1 ring-ink-200">
          {hits.length === 0 ? (
            <p className="px-3 py-4 text-sm text-ink-500">
              Nothing found. Try a fragment — a first name, a locality, four digits of a phone.
            </p>
          ) : (
            <ul className="max-h-96 divide-y divide-ink-100 overflow-y-auto">
              {hits.map((hit) => (
                <li key={`${hit.kind}-${hit.id}`}>
                  <button
                    onClick={() => go(hit)}
                    className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-ink-50"
                  >
                    <Badge tone={hit.kind === "case" ? "info" : "neutral"}>{hit.kind}</Badge>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{hit.title}</span>
                      <span className="block truncate text-xs text-ink-500">{hit.subtitle}</span>
                    </span>
                    {/* Why this matched. Search that explains itself teaches
                        people what else they could have typed. */}
                    <span className="shrink-0 text-xs text-ink-400">{hit.matchedOn}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A user with one role never sees a workspace switcher at all — the concept
 * stays invisible to the people who don't need it (PRD/Permissions.md).
 */
function WorkspaceTabs(): ReactNode {
  const session = useSession();

  if (session.availableWorkspaces.length < 2) {
    return (
      <div className="border-t border-ink-100 bg-ink-50/60">
        <div className="mx-auto w-full max-w-7xl px-4 py-1.5">
          <p className="text-xs text-ink-500">
            {WORKSPACE_QUESTIONS[session.workspace]}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-ink-100 bg-ink-50/60">
      <div className="mx-auto flex w-full max-w-7xl items-center gap-1 px-4">
        {session.availableWorkspaces.map((workspace) => (
          <button
            key={workspace}
            onClick={() => session.setWorkspace(workspace as Workspace)}
            className={cx(
              "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              session.workspace === workspace
                ? "border-brand-600 text-ink-900"
                : "border-transparent text-ink-500 hover:text-ink-700",
            )}
          >
            {WORKSPACE_LABELS[workspace]}
          </button>
        ))}
        <span className="ml-3 text-xs text-ink-500">
          {WORKSPACE_QUESTIONS[session.workspace]}
        </span>
      </div>
    </div>
  );
}

function UserSwitcher(): ReactNode {
  const db = useDatabase();
  const session = useSession();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-ink-50"
      >
        <span className="grid h-7 w-7 place-items-center rounded-full bg-ink-200 text-xs font-semibold">
          {session.user.name.slice(0, 2).toUpperCase()}
        </span>
        <span className="hidden text-left sm:block">
          <span className="block text-xs leading-tight font-medium">{session.user.name}</span>
          <span className="block text-xs leading-tight text-ink-500">
            {session.roles.map((role) => ROLE_LABELS[role as Role]).join(" + ")}
          </span>
        </span>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 w-72 rounded-lg bg-white p-2 shadow-lg ring-1 ring-ink-200">
          <p className="px-2 py-1 text-xs text-ink-500">
            Switch user. There is no login in the prototype — switching is how you see the
            permission model do something.
          </p>
          <ul className="mt-1">
            {db.users.map((user) => (
              <li key={user.id}>
                <button
                  onClick={() => {
                    session.setUserId(user.id);
                    setOpen(false);
                  }}
                  className={cx(
                    "w-full rounded px-2 py-1.5 text-left hover:bg-ink-50",
                    user.id === session.user.id && "bg-brand-100",
                  )}
                >
                  <span className="block text-sm font-medium">{user.name}</span>
                  <span className="block text-xs text-ink-500">
                    {user.roles.map((role) => ROLE_LABELS[role]).join(" + ")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <hr className="my-2 border-ink-100" />
          <button
            onClick={() => {
              if (confirm("Reset the prototype to its seed data? Anything you created is lost.")) {
                resetDatabase();
                setOpen(false);
              }
            }}
            className="w-full rounded px-2 py-1.5 text-left text-sm text-red-700 hover:bg-red-50"
          >
            Reset prototype data
          </button>
        </div>
      )}
    </div>
  );
}

function PrototypeFooter(): ReactNode {
  return (
    <footer className="border-t border-ink-200 bg-white">
      <div className="mx-auto w-full max-w-7xl px-4 py-3">
        <p className="text-xs text-ink-500">
          <strong className="font-medium text-ink-700">Prototype.</strong> Data is fake and lives in
          your browser. The business rules are not fake — stages, transitions, progress and
          permissions all run the real domain layer from <code>src/domain/</code>. If something is
          refused here, it will be refused in production for the same reason.
        </p>
      </div>
    </footer>
  );
}

export { WORKSPACES };
