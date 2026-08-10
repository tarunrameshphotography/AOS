# Session Checkpoint — 2026-08-11

**Stage 4, Item 3 — Authentication and Security.** Implemented and verified.
**Not declared complete, and not production-ready.** See "Where to resume".

Commits: `e0a1b25` (implementation), `702f203` (review pass + verification).
Tree green: typecheck clean, 616 unit tests, 133 integration tests, restore
drill 16/16, build green.

---

## The finding this item existed for (H3)

Measured against a live database, not inferred:

```
current_user  postgres    rolsuper = true    rolbypassrls = true
public tables 63          RLS enabled 62     pg_policies  0
table owner   postgres    — the same role the application connected as
```

**Row level security in AOS protected nothing, and could not.** Two
independent reasons, either fatal on its own: a superuser bypasses RLS
unconditionally (`FORCE` included), and there were no policies to bypass.
`Database/README.md` was honest about the second and silent about the first.

The configuration was also a trap in the other direction: pointing
`AOS_DB_USER` at an ordinary role — the obvious remedy — would have made every
query return zero rows, silently, and AOS would have appeared to lose its data.

---

## What was built

**`Database/migrations/0033_application_role.sql`** — additive only
(`CREATE ROLE`, `GRANT`, `CREATE POLICY`). Creates `aos_app`:

| | |
|---|---|
| Attributes | `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION` |
| Owns | nothing; no `CREATE` on `public`, `app` or `auth` |
| Operational tables (30) | `SELECT, INSERT, UPDATE` |
| `event` | `SELECT, INSERT` — **no `UPDATE`** |
| Catalogue/reference (30) | `SELECT` only, including `permission` / `role_permission` |
| `case_number_sequence` | no grant, no policy — only `app.allocate_case_number()` (SECURITY DEFINER) touches it |
| `DELETE` | **granted on nothing** |
| Password | **none** — the role cannot authenticate until an office sets one |

61 RLS policies, in two tiers:

- **Tier A** — `app_user`, `api_session`, `person`, `user_role`,
  `user_permission_override`, `permission`, `role_permission`: `using (true)`.
  Login must read these *before* an identity exists, because reading them is
  how one comes to exist. Stated openly rather than dressed up as protection.
- **Tier B** — everything else: `app.current_user_id() is not null`.

**What tier B buys:** a connection holding the `aos_app` password but not
inside an authenticated AOS transaction — a leaked `.env`, a `psql` session
from another PC on the LAN — reads no customer, case, document or submission
row. A deactivated employee is also refused at the database layer, because
`app.current_user_id()` filters on `is_active`.

**What it does not buy, and must never be described as buying:** per-user or
per-case access control. A SQL injection inside an already-authenticated
request passes the policy. Ownership is decided in `Backend/authorize.ts` and
proven in `Backend/api.test.ts`; ADR-022 forbids a second copy in SQL.

**BR-003 became a database property.** No request handler in `Backend/` issues
a `DELETE` — the only `delete from` statements in the repo are in
`src/domain/permissions/seed.ts`, which is migration tooling. So withholding
the privilege costs nothing and turns an injected `delete from loan_case` into
a permission error. `event` is append-only for the same reason.

### Other findings closed

| Finding | Fix |
|---|---|
| Dev seed password published in the repo | `seed-users.ts` contains no password; generated and printed once unless `AOS_SEED_PASSWORD` is set |
| `seed-users` had no database guard at all | Refuses a database holding the six real employees (**not** overridable), and any name not obviously development without `AOS_SEED_CONFIRM` |
| Bootstrap left the five dev accounts active by default | `bootstrap-production` disables them on **every** run; `--reset` accepted and now a documented no-op |
| CORS reflected any `Origin` | Allowlist from `AOS_WEB_PORT`, or `AOS_ALLOWED_ORIGINS`; foreign origins get no header |
| No login rate limiting | In-process throttle, keyed username **+** client address (username alone would be its own DoS) |
| Expired session untested | Covered |

### Files

```
Database/migrations/0033_application_role.sql   new
Backend/dev-accounts.ts                         new — DEV_SEED_USERNAMES +
                                                disableDevelopmentAccounts,
                                                extracted so tests can import
                                                it without firing a bootstrap
Backend/security.test.ts                        new — 25 integration tests
Backend/db.ts                                   adminPool / withAdmin /
                                                closeAdminPool
Backend/api-server.ts                           CORS allowlist, login throttle
Backend/seed-users.ts                           guards + generated password
Backend/bootstrap-production.ts                 unconditional deactivation
.env.example  Docs/Installation.md (§5a)  Database/README.md
```

---

## Verification actually performed

87 checks on databases created and dropped by the run. Never `aos`, never the
office. `.env` was not modified.

- **`aos_security_test`** — 0001→0033 from empty; the five role attributes; 61
  policies with no RLS table left policy-less except `case_number_sequence`;
  a direct `aos_app` connection blind without an identity, sighted with one,
  blind again after deactivation; `event` UPDATE/DELETE refused; `DELETE`
  refused everywhere; `COPY … TO PROGRAM`, `COPY FROM` a server file,
  `pg_authid`, `CREATE TABLE`, `ALTER TABLE`, `role_permission` UPDATE all
  refused. **28/28**
- **`aos_security_test`, part two** — the real `Backend/api-server.ts` spawned
  with `AOS_DB_USER=aos_app`, confirmed via `pg_stat_activity`, driven over
  HTTP: login, `/auth/me`, cases, reference, lenders, search, customer + case
  creation (`allocate_case_number`), update, stage transition, the requirement
  rule engine, user administration, overrides, deactivation, the
  telecaller/telecaller 404 boundary, manager access, 403 on `user.manage`,
  logout; CORS ×4; throttle ×4. **35/35**
- **`aos_security_office`** — a production-*shaped* name, because
  `bootstrap-production` refuses `/test/i` and **that guard was not weakened
  for a test**. seed-users refused without `AOS_SEED_CONFIRM`, worked with it
  through the admin pool while `AOS_DB_USER=aos_app`, then was refused
  outright once the six real employees existed; bootstrap disabled all five
  with no flags, revoked their sessions, kept the records and the audit
  events, and was idempotent. **24/24**

**The API genuinely ran as `aos_app`** — not simulated, not a fallback.

---

## Where to resume

### Blocking decision before any office deployment

**The `.env` switch is untested for three surfaces.** `security.test.ts` and
the 87 checks cover a lot, but document upload/download, bank submissions and
mail have never been driven through an `aos_app` connection. They are the most
likely place for a missing grant. `Docs/Installation.md` §5a therefore tells
the operator to exercise exactly those and revert two `.env` lines if anything
500s. **Recommended: run §5a against a restored copy of the office database
first, not the live one.**

### Immediate, on this machine

**The dev database `aos` reports `CHANGED 0033_application_role.sql`.** The
review pass edited 0033 after it had been applied there, and the checksum guard
correctly blocks the next `npm run migrate`. Not touched deliberately — it is
the Home PC development database and dropping it is the user's call. The
substantive difference is two no-op `revoke create on schema app/auth`
statements; everything else is comments. Options: drop and rebuild `aos`, or
re-record the checksum by hand. `aos_test` was dropped and rebuilt already.

### Known limitations, deferred on purpose

1. **Column masking (ADR-026) is still unbuilt.** 0033 did row visibility and
   privileges. Masked views were never started; `Database/README.md` says so.
2. **RLS is not a per-user boundary.** By design — see above. Anything that
   later claims otherwise is wrong.
3. **Login timing leaks username existence** (~1ms unknown vs ~80ms wrong
   password). Messages are identical and tested; timing is not equalised.
   LAN-only system, judged marginal.
4. **The throttle is in-process.** A restart clears the counters, and it would
   not be shared if AOS ever ran two API processes. Honest for a
   one-process-on-one-PC deployment (`Docs/Deployment Topology.md`).
5. **`Backend/customers.ts` contains a NUL byte** (a deliberate composite-key
   separator, predating this work), so git treats it as binary and it does not
   diff. Same idiom was removed from `api-server.ts`; left alone here as out of
   scope.

### Still to execute on the office server — none of it done

1. `npm run migrate` (applies 0033; must run as a superuser).
2. `psql -c "alter role aos_app password '<long random>'"`.
3. `.env`: `AOS_DB_USER=aos_app`, `AOS_DB_PASSWORD=…`,
   `AOS_DB_ADMIN_USER=postgres`, `AOS_DB_ADMIN_PASSWORD=…`.
4. Restart; sign in, open a case, **upload a document**, **send a submission**.
5. `npm run bootstrap-production` — disables the five dev accounts on its own.
6. Confirm `is_active = f` for all five.

### Not started

**Stage 4 Item 4.** Deliberately untouched — Item 3 was to be finished and
verified first.

Untouched throughout, per instruction: firewall, Windows services, the office
server, Gmail credentials, the 188 orphaned `C:\AOS\Data` files, production
data, and the Home PC `.env`.
