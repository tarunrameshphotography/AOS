import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";

import { ROLE_LABELS, type Role } from "@domain/permissions/index.js";

import { api } from "./api/client.js";
import type { ApiSearchHit } from "./api/types.js";
import { resetDatabase } from "./fake/store.js";
import { CaseDetail } from "./screens/CaseDetail.js";
import { CaseList } from "./screens/CaseList.js";
import { DocumentRules } from "./screens/DocumentRules.js";
import { LenderCatalogue } from "./screens/LenderCatalogue.js";
import { LendingProducts } from "./screens/LendingProducts.js";
import { MasterData } from "./screens/MasterData.js";
import { NewCase } from "./screens/NewCase.js";
import { PersonProfile } from "./screens/PersonProfile.js";
import { UserManagement } from "./screens/UserManagement.js";
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
          <Route path="/admin/lending-products" element={<LendingProducts />} />
          <Route path="/admin/lenders" element={<LenderCatalogue />} />
          <Route path="/admin/document-rules" element={<DocumentRules />} />
          <Route path="/admin/master-data" element={<MasterData />} />
          <Route path="/admin/users" element={<UserManagement />} />
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

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return cx(
    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-150",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1",
    isActive ? "bg-brand-50 text-brand-700" : "text-ink-700 hover:bg-ink-50",
  );
}

function TopBar(): ReactNode {
  const session = useSession();

  return (
    <header className="sticky top-0 z-40 border-b border-ink-150 bg-white">
      <div className="mx-auto flex w-full max-w-7xl items-center gap-4 px-4 py-2.5">
        <Link to="/" className="flex shrink-0 items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-brand-600 text-xs font-bold text-white">
            AL
          </span>
          <span className="font-display text-sm font-semibold tracking-tight">AOS</span>
        </Link>

        <GlobalSearch />

        <nav className="ml-auto flex shrink-0 items-center gap-1">
          {/* Distinct from "All Cases" below: this is the work queue, scoped to
              what this role/session should be looking at right now. Before
              this label existed, the logo was the only way to it, and nothing
              distinguished "your work" from "every case" (audit finding 11.1). */}
          <NavLink to="/" end className={navLinkClass}>
            My Work
          </NavLink>
          <NavLink to="/cases" className={navLinkClass}>
            All Cases
          </NavLink>
          {session.can("master_data.manage", "all") && (
            <NavLink to="/admin/lending-products" className={navLinkClass}>
              Products
            </NavLink>
          )}
          {session.can("master_data.manage", "all") && (
            <NavLink to="/admin/lenders" className={navLinkClass}>
              Lenders
            </NavLink>
          )}
          {session.can("master_data.manage", "all") && (
            <NavLink to="/admin/document-rules" className={navLinkClass}>
              Document Rules
            </NavLink>
          )}
          {session.can("master_data.manage", "all") && (
            <NavLink to="/admin/master-data" className={navLinkClass}>
              Master Data
            </NavLink>
          )}
          {session.can("user.manage", "all") && (
            <NavLink to="/admin/users" className={navLinkClass}>
              Users
            </NavLink>
          )}
          {session.can("case.create", "all") && (
            <Link to="/cases/new">
              <Button variant="primary">New case</Button>
            </Link>
          )}
        </nav>

        <IdentityMenu />
      </div>

      <WorkspaceTabs />
    </header>
  );
}

/**
 * One search box. Not a person search and a case search and a document search —
 * one box, mixed results, grouped by type.
 *
 * Stage 3B: the search runs on the server (`GET /api/search`). That is not a
 * performance change, it is a correctness one. The old version searched the
 * cases and people the browser happened to be holding, so it found things in
 * proportion to what had already been loaded. It now searches the database,
 * and — importantly — the server applies the case scope rule, so a Telecaller
 * typing a colleague's case number finds nothing rather than finding a case
 * they may not open.
 *
 * Organisations and properties have dropped out of the results for now: they
 * have not migrated, and searching the prototype store for them would return
 * records with ids that no longer resolve to anything the case screens can
 * open.
 */
function GlobalSearch(): ReactNode {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<readonly ApiSearchHit[]>([]);
  const container = useRef<HTMLDivElement>(null);

  const trimmed = query.trim();

  // Debounced: this fires per keystroke, and the office runs one small server.
  useEffect(() => {
    if (trimmed.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api<readonly ApiSearchHit[]>(`/search?q=${encodeURIComponent(trimmed)}`)
        .then((found) => {
          if (!cancelled) setHits(found);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed]);

  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const go = (hit: ApiSearchHit): void => {
    setOpen(false);
    setQuery("");
    if (hit.kind === "case") navigate(`/cases/${hit.id}`);
    else navigate(`/people/${hit.id}`);
  };

  return (
    <div ref={container} className="relative w-full max-w-md">
      {/* The one icon on the whole nav bar — a search box reads as a search
          box faster with the glass in it, and nowhere else in this bar needs
          the help. */}
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-ink-400"
        fill="none"
      >
        <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M10 10l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <input
        value={query}
        name="search"
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search cases, people, phone numbers…"
        className="w-full rounded-md bg-ink-50 py-1.5 pr-3 pl-8 text-sm ring-1 ring-ink-150 transition-shadow duration-150 focus:bg-white focus:ring-2 focus:ring-brand-500 focus:outline-none"
      />

      {open && trimmed.length >= 2 && (
        <div className="aos-animate-pop absolute top-full left-0 mt-1 w-full overflow-hidden rounded-lg bg-white shadow-elevated ring-1 ring-ink-150">
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
      <div className="border-t border-ink-100 bg-brand-50/40">
        <div className="mx-auto w-full max-w-7xl px-4 py-1.5">
          <p className="text-xs text-ink-500">
            {WORKSPACE_QUESTIONS[session.workspace]}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-ink-100 bg-brand-50/40">
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

/**
 * Identity display and sign-out — the authenticated employee's name and
 * role(s), with a logout action. There is no other-user list here any more
 * (Employee Authentication milestone): the normal way to become someone else
 * is for that person to sign in themselves, not to pick their name from a
 * menu. "Clear local preview data" stays — it wipes the still-local
 * Products/Lenders screens and Master Data's remaining local sections back to
 * their seed, a dev/QA convenience unrelated to identity, gated on
 * master_data.manage (nobody without a reason to see those screens sees this
 * either), and worded to say plainly that it does not touch anything on the
 * server. IT NO LONGER TOUCHES Document Rules, Document Types, Rejection
 * Reasons or Thresholds — those save to the office database as of Stage 4
 * Item 4, so clearing this browser's localStorage has no effect on them.
 */
function IdentityMenu(): ReactNode {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  // Mirrors GlobalSearch's own close-on-outside-click, above — its absence
  // here was the bug: nothing closed this menu except its own two actions.
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div ref={container} className="relative shrink-0">
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-ink-50"
      >
        <span className="grid h-7 w-7 place-items-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
          {session.displayName.slice(0, 2).toUpperCase()}
        </span>
        <span className="hidden text-left sm:block">
          <span className="block text-xs leading-tight font-medium">{session.displayName}</span>
          <span className="block text-xs leading-tight text-ink-500">
            {session.roles.map((role) => ROLE_LABELS[role as Role]).join(" + ")}
          </span>
        </span>
      </button>

      {open && (
        <div className="aos-animate-pop absolute top-full right-0 mt-1 w-64 rounded-lg bg-white p-2 shadow-elevated ring-1 ring-ink-150">
          <div className="px-2 py-1.5">
            <p className="text-sm font-medium">{session.displayName}</p>
            <p className="text-xs text-ink-500">
              {session.roles.map((role) => ROLE_LABELS[role as Role]).join(" + ")}
            </p>
          </div>
          <hr className="my-2 border-ink-100" />
          <button
            onClick={() => {
              setOpen(false);
              session.logout();
            }}
            className="w-full rounded px-2 py-1.5 text-left text-sm text-ink-700 hover:bg-ink-50"
          >
            Log out
          </button>
          {session.can("master_data.manage", "all") && (
            <button
              onClick={() => {
                if (
                  confirm(
                    "Clear this browser's local copy of Products, Lenders and the remaining " +
                      "preview sections of Master Data back to their starting values?\n\n" +
                      "This does NOT reset AOS. It has no effect on real cases, customers, " +
                      "documents, users, document rules, document types, rejection reasons or " +
                      "thresholds — those live on the office server. It only clears the " +
                      "not-yet-connected preview screens, in this browser only.",
                  )
                ) {
                  resetDatabase();
                  setOpen(false);
                }
              }}
              className="w-full rounded px-2 py-1.5 text-left text-sm text-red-700 hover:bg-red-50"
            >
              Clear local preview data (not AOS data)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PrototypeFooter(): ReactNode {
  return (
    <footer className="border-t border-ink-150 bg-white">
      <div className="mx-auto w-full max-w-7xl px-4 py-3">
        <p className="text-xs text-ink-500">
          Cases, customers, users, documents, requirements, document rules, document types,
          rejection reasons and thresholds are saved on the office server — shared by every PC,
          and safe across a refresh. Products, Lenders and the rest of Master Data's fixed
          vocabulary are still local to this browser, pending their own migration. Stages,
          transitions, progress and permissions all run the real domain layer from{" "}
          <code>src/domain/</code>; if something is refused here, it is refused for the same
          reason in every other screen.
        </p>
      </div>
    </footer>
  );
}

export { WORKSPACES };
