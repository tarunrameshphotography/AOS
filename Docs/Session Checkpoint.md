# Session Checkpoint — 2026-08-11

**Stage 4, Item 3 — Authentication and Security. Complete and verified.**

Commits: `e0a1b25` (implementation), `702f203` (review pass + verification),
`1a4c79b` (previous checkpoint), plus this session's commit (workflow
verification + dev-database rebuild — see below for the hash).

Tree green: typecheck clean, 616 unit tests, 134 integration tests, restore
drill 16/16, build green.

---

## What this session closed

The previous checkpoint left one blocking gap: document upload/download,
bank submissions and mail had never been driven through an `AOS_DB_USER=aos_app`
connection. Everything else in Item 3 (the role itself, RLS, the auth
lifecycle, CORS, throttling, bootstrap) was already verified.

**`Backend/security-workflows.test.ts`** — new. Against a disposable
`aos_test` database (0001→0033, the same database `security.test.ts` and the
rest of the integration suite share), with a real out-of-process API server
connected as `aos_app` (mirroring `security.test.ts`'s
`startAppRoleServer`), a real throwaway `storage-server.mjs`, and a real
`mail-server.mjs` in `capture` mode (writes to a temp directory, never
reaches Gmail):

1. Created a synthetic customer and case.
2. Listed rule-generated requirements.
3. Uploaded a synthetic document (`tests/fixtures/pan-card.pdf`) through the
   real API → `documents.ts` → storage backend path, for every requirement.
4. Verified each document (`document.verify`, as a Login Executive).
5. Downloaded the document back and confirmed the bytes and SHA-256 hash
   match the original exactly — the full round trip through the real storage
   backend as `aos_app`.
6. Ran the real bank submission path: branch lookup, submission +
   recipient inserts, `sendable-documents`, `prepare` (pure), `send` (package
   / email / document inserts, per-email status updates, then the
   submission and case updates) — all against Postgres as `aos_app`.
7. `send` went through the real (capture-mode) mail backend — proving the
   database interactions the mail path depends on work as `aos_app`, without
   sending anything or touching a real credential.
8. Confirmed the specific `event` rows this workflow produced
   (`document.uploaded`, `document.verified`, `submission.created`,
   `submission.documents_sent`, `case.stage_changed`) exist, and that
   `aos_app` can neither `UPDATE` nor `DELETE` them — checked against those
   exact rows, not a generic probe.
9. Confirmed requirements, document metadata and submissions read back
   exactly as the application expects after the whole flow (outstanding
   requirement count is 0; the submission shows `status = "submitted"`).

No missing grant was found. `0033_application_role.sql` was not changed this
session — the earlier review pass had already covered everything these three
paths needed.

**The Home-PC `aos` checksum mismatch is resolved.** `aos` (confirmed local:
`127.0.0.1`, not the office) was dropped and recreated, migrated 0001→0033
clean (no `CHANGED` entries), reseeded with the standard five development
accounts (`AOS_SEED_CONFIRM=aos npm run seed-users`), and the real
`api-server` was started against it and a login exercised successfully
before being stopped. `.env` was not modified; `AOS_DB_USER` is still
`postgres` on this machine, as it was before.

---

## Verification actually performed, this session

- **26 security integration tests** (`security.test.ts` + the new
  `security-workflows.test.ts`) — the full role/RLS/lifecycle/CORS/throttle/
  bootstrap suite from the last checkpoint, plus the three newly-covered
  workflows, run together against the same `aos_test` database. All 26 pass.
- **`npm run typecheck`** — clean.
- **`npm test`** — 616/616 unit tests.
- **`npm run test:integration`** — 134/134 (133 previously + the new
  workflow test), across all 8 integration files including
  `security-workflows.test.ts`.
- **`npm run build`** — clean (pre-existing >500kB chunk-size warning,
  unrelated to this item).
- **`npm run restore-drill`** — 16/16.
- **File review** — `git status` shows exactly one new file
  (`Backend/security-workflows.test.ts`) and no other changes. No duplicate
  imports, no dead code, no stale comments, no secrets, no broad grants.
  (One dead field — `Session.authIdentityId`, set but never read — was
  caught and removed before commit.)

---

## Known limitations, deferred on purpose (unchanged from the last checkpoint)

1. **Column masking (ADR-026) is still unbuilt.** 0033 did row visibility and
   privileges. Masked views were never started; `Database/README.md` says so.
2. **RLS is not a per-user boundary.** By design. Ownership is decided in
   `Backend/authorize.ts`; anything claiming RLS enforces it is wrong.
3. **Login timing leaks username existence** (~1ms unknown vs ~80ms wrong
   password). LAN-only system, judged marginal.
4. **The throttle is in-process.** A restart clears counters; not shared
   across processes. Honest for a one-process-on-one-PC deployment.
5. **`Backend/customers.ts` contains a NUL byte** (a deliberate composite-key
   separator, predating this work) — out of scope, unchanged.

---

## Still to execute on the office server — none of it done, none of it touched

1. `npm run migrate` (applies 0033; must run as a superuser).
2. `psql -c "alter role aos_app password '<long random>'"`.
3. `.env`: `AOS_DB_USER=aos_app`, `AOS_DB_PASSWORD=…`,
   `AOS_DB_ADMIN_USER=postgres`, `AOS_DB_ADMIN_PASSWORD=…`.
4. Restart; sign in, open a case, upload a document, send a submission —
   this session's tests prove the code path works as `aos_app`; the office
   server still needs its own live check once the switch is made there, per
   `Docs/Installation.md` §5a (recommended: against a restored copy of the
   office database first, not the live one).
5. `npm run bootstrap-production` — disables the five dev accounts on its
   own.
6. Confirm `is_active = f` for all five.

Untouched throughout, per instruction: firewall, Windows services, the office
server, Gmail credentials, the 188 orphaned `C:\AOS\Data` files, production
data, and the Home PC `.env` (still `postgres`/`aos`, deliberately — the task
was to fix the checksum, not to switch this machine to `aos_app`).

---

## Not started

**Stage 4 Item 4.** Deliberately untouched.
