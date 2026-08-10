# Deployment Topology

Who runs what, on which machine, in the Amaze Loans office.

## The rule

**Exactly one PC in the office is the AOS server.** It runs PostgreSQL and the
four AOS processes. Every other PC opens a browser to that machine's address
and runs nothing at all — no Node, no `npm`, no checkout of this repository.

```
┌──────────────────────────────────────┐         ┌────────────────────┐
│  THE SERVER PC                       │         │  Every other PC    │
│                                      │         │                    │
│  PostgreSQL        127.0.0.1:5432    │         │  A browser,        │
│  storage-server    127.0.0.1:4319    │   LAN   │  pointed at        │
│  mail-server       127.0.0.1:4320    │◄────────┤  http://<server    │
│  api-server        127.0.0.1:4321    │         │   IP>:4300         │
│  web-server        0.0.0.0:4300  ◄───┼─────────┘                    │
│                                      │         │  Nothing installed │
│  C:\AOS\Data      documents          │         │                    │
│  C:\AOS\Backups   backups            │         └────────────────────┘
└──────────────────────────────────────┘
```

**One port is open to the office: 4300.** Everything else is loopback.

## Why only the web server faces the network

Each process below it is reachable only from the machine it runs on, and that
is the access control:

| Process | Binds | Why |
|---|---|---|
| `web-server.mjs` | `AOS_WEB_HOST`, default loopback, **0.0.0.0 on the server** | Serves the built frontend and proxies `/api`. The only front door. |
| `api-server.ts` | loopback (configurable, but leave it) | Enforces every permission. Reached through the web server's proxy. |
| `storage-server.mjs` | **loopback, always — refuses otherwise** | No authentication. Anything that reaches it can read or overwrite every customer's documents and relocate the whole store via `PUT /config`. |
| `mail-server.mjs` | **loopback, always — refuses otherwise** | No authentication, and holds the Gmail refresh token. Anything that reaches it can send email as Amaze Loans, to anyone, including banks. |
| PostgreSQL | loopback | Only the API talks to it. |

The two "refuses otherwise" entries are enforced in code: setting
`AOS_STORAGE_HOST` or `AOS_MAIL_HOST` to anything but loopback makes that
process exit with an explanation. If document bytes ever need to leave the
machine directly, the answer is authentication on that server, not a wider
bind — and that refusal exists to force the conversation rather than let it
happen by analogy with the web server's setting.

## Why employee PCs must not run the backend

If a second PC runs `npm run dev` — even once, even by accident — that machine
gets:

- its own empty PostgreSQL, so it sees no cases and creates cases nobody else sees;
- **its own `C:\AOS\Data`**, so documents uploaded through it land on that
  employee's local disk, are invisible to the rest of the office, are not in
  any backup, and are lost when that PC is reimaged.

Nothing in the system detects this. The employee's screen looks completely
normal. This is the single most damaging misconfiguration available, which is
why the topology is stated as a rule rather than a recommendation.

## What each setting means

| Setting | Server PC | Anywhere else |
|---|---|---|
| `AOS_WEB_HOST` | `0.0.0.0` | `127.0.0.1` |
| `AOS_WEB_PORT` | `4300` | `4300` |
| `AOS_API_HOST` | `127.0.0.1` | `127.0.0.1` |
| `AOS_DB_HOST` | `127.0.0.1` | — |
| `AOS_DB_NAME` | `aos` | never `aos` |
| `AOS_STORAGE_ROOT` | `C:\AOS\Data` | — |
| `AOS_BACKUP_ROOT` | a **different disk** from the documents | — |
| `AOS_MAIL_PROVIDER` | `gmail` | `unconfigured` |

`AOS_MAIL_PROVIDER=capture` is for automated tests only. It reports success
and sends nothing, so an office install running it would record submissions
that never left the building. `Scripts/aos-status.ps1` flags it in red.

## Starting, stopping, and surviving a reboot

One process supervises the other four:

```
npm run start:production          # Backend/supervisor.mjs, foreground
Scripts/register-aos-services.ps1 # register it to start at boot
Scripts/aos-status.ps1            # is everything up?
```

The supervisor:

- **waits up to two minutes for PostgreSQL** before starting the API. On a
  Windows reboot both start at once and Postgres routinely wins the race by
  thirty seconds; without the wait, an employee logging in during that window
  is told AOS is broken.
- **restarts any process that exits**, backing off 1s → 2s → 4s … → 60s, so a
  crash-loop leaves a readable log instead of filling the disk.
- **sweeps its own four ports for orphaned Node processes at startup.** Windows
  does not tear down a process tree when an ancestor dies, so a force-killed
  supervisor or a power cut leaves children holding the ports and the next
  start would otherwise fail with `EADDRINUSE` forever.
- **refuses to start if another supervisor is already running** (PID file at
  `Backend/supervisor.pid`). Two supervisors kill each other's children and
  present as an application that flickers in and out.

PostgreSQL is *not* started by the supervisor — it is its own Windows service
and already starts automatically.

## What happens when something is unavailable

| Failure | What an employee sees | Where the detail goes |
|---|---|---|
| PostgreSQL stopped | `503` "AOS cannot reach its database right now, so nothing was saved… the AOS server PC needs attention." | Driver error in the API log |
| API process stopped | `503` "AOS is running but its API is not responding. Nothing was saved." | Supervisor log, with restarts |
| Storage server stopped | Upload fails: "The document could not be stored. Check that the storage backend is running and try again." | API log |
| Gmail unreachable / not configured | The submission records the email as `failed` with a reason, and **Retry** resends only the failed ones. Nothing is silently marked sent. | `submission_package_email.status` |
| Whole server PC off | "Cannot reach the AOS server. Check that it is running." | — |

No PostgreSQL error text, table name, column name or connection string ever
reaches a browser.

## Firewall

On the server PC, allow **inbound TCP 4300** only:

```powershell
New-NetFirewallRule -DisplayName "AOS web (4300)" -Direction Inbound `
    -Action Allow -Protocol TCP -LocalPort 4300 -Profile Private
```

`-Profile Private` matters: the office network must be classified Private, or
the rule will not apply. Do **not** open 4319, 4320, 4321 or 5432 — nothing
outside the server PC has any reason to reach them, and three of the four have
no authentication.

## Still to be recorded by whoever installs the office server

These cannot be guessed from a development checkout, and a wrong confident
answer in this table is worse than a blank one.

| | |
|---|---|
| Server PC (make / asset tag / location) | *(not yet recorded)* |
| Server LAN IP, static or DHCP-reserved | *(not yet recorded)* |
| URL employees use | *(not yet recorded — `http://<IP>:4300`)* |
| Backup destination (physical location) | *(not yet recorded)* |
| Who holds the database password and the login slips | *(not yet recorded)* |

A server whose IP changes on reboot breaks every bookmark in the office
silently — reserve it in the router against that PC's MAC address before
go-live. `Docs/Installation.md` is the step-by-step procedure.
