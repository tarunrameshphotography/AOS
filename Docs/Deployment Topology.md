# Deployment Topology

Who runs what, on which machine, in the Amaze Loans office. Written because
nothing else in the repository says this in one place, and three separate
processes (Postgres, `api-server.ts`, `storage-server.mjs`) silently depend on
running together on the same PC — see "Why this is one machine" below.

## The rule

**Exactly one PC in the office is the AOS server.** It is the only machine
that runs Postgres, `npm run api-server`, and `npm run storage-server` (or the
bundled `npm run dev`, which starts all of them together). Every other PC in
the office only opens a browser to that machine's address — it never runs its
own copy of the backend, and never runs `npm run dev` itself.

```
┌─────────────────────────────┐         ┌──────────────────┐
│   THE SERVER PC              │         │  Every other PC   │
│                               │         │                    │
│   PostgreSQL  (:5432)        │◄────────┤  Browser only,     │
│   api-server  (:4321)        │  LAN    │  pointed at the    │
│   storage-server (:4319)     │         │  server's address  │
│   mail-server (:4320)        │         │                    │
│   C:\AOS\Data  (documents)   │         │                    │
│   C:\AOS\Backups             │         │                    │
└─────────────────────────────┘         └──────────────────┘
```

## Why this is one machine, not a choice

- `AOS_DB_HOST=127.0.0.1` in `.env` — the API only ever talks to Postgres on
  its own machine.
- `storage-server.mjs` binds to `127.0.0.1` only (see its file header) — it is
  not reachable from any other PC on the network. The API server is the only
  process allowed to read or write document bytes, and it reaches the storage
  server over loopback, which only works if both run on the same box.
- Document bytes live at `AOS_STORAGE_ROOT` (default `C:\AOS\Data`) on
  whichever machine `storage-server.mjs` happens to run on. If a second PC
  ever ran its own copy — even by accident, via `npm run dev` — its local disk
  would silently become a second, disconnected document store: uploads made
  through it would never appear to anyone else, and nothing would warn that
  this had happened.

**Employees must not run `npm run dev` (or any of the individual `api-server`
/ `storage-server` / `mail-server` scripts) on their own PC.** Those commands
are for the server PC and for development machines working on AOS itself —
never for a desk that is only meant to be using the finished system.

## What today's configuration says

Read from this checkout's `.env` at the time this was written:

| Setting | Value | Meaning |
|---|---|---|
| `AOS_DB_HOST` | `127.0.0.1` | Postgres is reached over loopback — API and DB are co-located. |
| `AOS_DB_NAME` | `aos` | The one real database. Never point a second machine's backend at it. |
| `AOS_API_PORT` | `4321` | Other PCs reach the API at `http://<server-IP>:4321`. |
| `AOS_STORAGE_PORT` | `4319` | Loopback-only; never reached directly by another PC. |
| `AOS_STORAGE_ROOT` | `C:\AOS\Data` | Document bytes, on the server PC's own disk. |
| `AOS_BACKUP_ROOT` | `C:\AOS\Backups` | Backups (see `Backend/backup.mjs`), ideally on a **different** disk than `AOS_STORAGE_ROOT`. |

## What is NOT yet filled in — needs an office decision

This machine (the one this audit ran on) is a development checkout, not the
office server — its hostname and address are not recorded here because
guessing would put a wrong, confident-looking answer in a document someone
will trust later. Before go-live, whoever sets up the office PC should record:

1. **Which physical PC is the server.** Make/model or asset tag, and its
   location in the office (e.g. "front desk PC" or "the one under Tarun's
   desk").
2. **Its LAN IP address**, and whether it is static or DHCP-reserved. A
   server whose address changes on reboot breaks every other PC's bookmark
   silently. `ipconfig` on that machine, under the office Wi-Fi/Ethernet
   adapter, gives the current address — reserve it in the router as static or
   as a DHCP reservation keyed to that PC's MAC address.
3. **What URL the other PCs use.** Once the IP is fixed, e.g.
   `http://192.168.1.50:4321` for the API and the built frontend served from
   it (or wherever `npm run build && npm run preview` / a static host serves
   `Frontend/`).
4. **Where `AOS_BACKUP_ROOT` actually lives.** A folder on the server's C:
   drive protects against database corruption but not against that PC's disk
   failing outright. A mapped drive to a second machine, an external drive
   swapped periodically, or a cloud-synced folder are all better than nothing
   — pick one and record it here.
5. **Who has the office database password and the six employees' login
   slips**, and where those are kept (a locked drawer, not a sticky note on
   the monitor).

Fill in the table below once those are known; nothing else in this document
needs to change until the office's physical setup does.

| | |
|---|---|
| Server PC (make/asset tag/location) | *(not yet recorded)* |
| Server LAN IP (static/reserved) | *(not yet recorded)* |
| Frontend URL for other PCs | *(not yet recorded)* |
| Backup destination (physical location) | *(not yet recorded)* |
