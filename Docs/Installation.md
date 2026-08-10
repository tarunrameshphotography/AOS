# Installing AOS on the office server

Written to be followed by someone who has not worked on AOS. Every step says
what to type and how to know it worked. Where a step can go wrong quietly, it
says how to tell.

**Read `Docs/Deployment Topology.md` first.** One PC is the server. No other
PC runs any part of this.

Time: about an hour, most of it PostgreSQL's installer.

---

## Before you start

- [ ] The PC that will be the server is chosen, and it is the one that stays on.
- [ ] It has a **static or DHCP-reserved LAN IP**. Reserve it in the router
      against this PC's MAC address now — everything else depends on the
      address not changing.
- [ ] You have somewhere to put backups that is **not this PC's C: drive**: a
      second internal disk, an external drive, or a mapped network drive.
- [ ] You can sign in as an account that stays logged in / can run a scheduled
      task.

---

## 1. Install the prerequisites

**Node.js 20 or later** — https://nodejs.org, LTS installer, defaults are fine.

```powershell
node --version      # must print v20 or higher
```

**PostgreSQL 17** — https://www.postgresql.org/download/windows/

During the installer:
- Set a password for the `postgres` superuser. **Write it down and keep it
  somewhere physically secure** — a locked drawer, not a sticky note. You
  cannot recover it, and a restore needs it.
- Port `5432`, default locale.
- Stack Builder at the end: not needed, skip it.

```powershell
Get-Service postgresql*     # must show Running
```

---

## 2. Get AOS onto the machine

Put the checkout somewhere permanent — not on the Desktop, not in Downloads.
`C:\AOS\App` is a reasonable choice.

```powershell
cd C:\AOS\App
npm ci
```

`npm ci` rather than `npm install`: it installs exactly the versions in
`package-lock.json`, so the office runs what was tested.

---

## 3. Create the database

```powershell
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -c "create database aos"
```

It will prompt for the `postgres` password from step 1.

---

## 4. Configure it

Copy `.env.example` to `.env` and edit it. `.env` is git-ignored and must never
be committed.

```powershell
cd C:\AOS\App
Copy-Item .env.example .env
notepad .env
```

The values that matter on the server:

```ini
AOS_DB_HOST=127.0.0.1
AOS_DB_PORT=5432
AOS_DB_NAME=aos
AOS_DB_USER=postgres
AOS_DB_PASSWORD=<the password from step 1>

# THIS is what makes AOS reachable from other PCs. Only on this machine.
AOS_WEB_HOST=0.0.0.0
AOS_WEB_PORT=4300

AOS_STORAGE_ROOT=C:\AOS\Data
AOS_BACKUP_ROOT=D:\AOS-Backups      # a DIFFERENT disk from the documents
AOS_BACKUP_RETENTION=14

AOS_MAIL_PROVIDER=unconfigured      # set to gmail in step 9
```

> **`AOS_BACKUP_ROOT` on the same disk as `AOS_STORAGE_ROOT` protects you
> against database corruption and against nothing else.** That disk failing
> takes both. Use a second disk, an external drive, or a network share.

---

## 5. Create the schema

```powershell
npm run migrate
npm run migrate:status     # every line should say "applied"
```

If a line says `CHANGED`, an already-applied migration file has been edited
since. Stop and ask — do not force it.

---

## 5a. Stop AOS connecting as a superuser

**Do this before AOS holds any real customer file.** Steps 1 and 4 have the
application connecting as `postgres`, which is a PostgreSQL superuser: it can
run programs on this PC, read any file the PostgreSQL service can read, read
every role's password hash, and erase the audit log. Nothing AOS does needs any
of that. Migration `0033` created a role — `aos_app` — that can do none of it,
and left it with **no password**, so it cannot be used until you set one here.

Pick a long random password. It is typed twice, here and into `.env`, and never
again; nobody has to remember it.

```powershell
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -d aos -c `
  "alter role aos_app password 'PASTE-A-LONG-RANDOM-PASSWORD-HERE'"
```

Then edit `.env`:

```ini
AOS_DB_USER=aos_app
AOS_DB_PASSWORD=<the aos_app password you just set>

# The administrative scripts — seed-users, bootstrap-production — deliberately
# CANNOT run as aos_app: it is not allowed to create accounts or write to the
# event log outside an authenticated request. These two lines let those scripts
# keep using the owner account while the running application does not.
AOS_DB_ADMIN_USER=postgres
AOS_DB_ADMIN_PASSWORD=<the postgres password from step 1>
```

Restart AOS and confirm it still works — sign in, open a case, upload a
document. If anything returns "Something went wrong", revert the two
`AOS_DB_USER`/`AOS_DB_PASSWORD` lines to `postgres`, restart, and report what
failed: it means a table or privilege was missed, and running as superuser is
better than running not at all while that is fixed.

> **What this buys.** A bug or an injection in AOS can no longer reach the rest
> of the machine, and can no longer delete anything — `aos_app` holds no
> `DELETE` privilege on any table, so BR-003 ("nothing is hard-deleted") is now
> enforced by PostgreSQL rather than by the application happening not to try.
> The `event` log becomes append-only for the same reason.
>
> **What it does not buy.** It does not change who may see which case. That is
> decided by the API (`Backend/authorize.ts`) and is unchanged.

---

## 6. Build the frontend

```powershell
npm run build
```

This produces `Frontend/dist`, which the web server serves. **Re-run it every
time you update AOS**, or employees keep getting the old interface.

---

## 7. Start it, and check it

```powershell
npm run start:production
```

Leave it running and, in a second window:

```powershell
.\Scripts\aos-status.ps1
```

Every line except the scheduled tasks and the backup should say `UP`. If
"Employee access" says DOWN, `AOS_WEB_HOST` is still `127.0.0.1` — fix `.env`
and restart.

Stop it with Ctrl-C for now.

---

## 8. Open the firewall

```powershell
New-NetFirewallRule -DisplayName "AOS web (4300)" -Direction Inbound `
    -Action Allow -Protocol TCP -LocalPort 4300 -Profile Private
```

Check the office network is classified **Private**, or the rule does nothing:

```powershell
Get-NetConnectionProfile
```

Do not open 4319, 4320, 4321 or 5432. Three of those have no authentication.

**Test from another PC now**, before going further: browse to
`http://<server IP>:4300`. You should get the AOS login screen. If you do not,
nothing after this point matters yet.

---

## 9. Connect the mailbox (optional, needed for bank submissions)

Follow the Gmail OAuth steps in `.env.example`, then set:

```ini
AOS_MAIL_PROVIDER=gmail
AOS_GMAIL_CLIENT_ID=...
AOS_GMAIL_CLIENT_SECRET=...
AOS_GMAIL_REFRESH_TOKEN=...
```

Restart AOS and confirm:

```powershell
.\Scripts\aos-status.ps1     # Mail backend: provider 'gmail' - able to send
```

Until this is done every submission is refused with a clear message. Nothing
is queued and nothing is faked — which is the right behaviour, but it does
mean bank submission does not work until this step is complete.

> **Never set `AOS_MAIL_PROVIDER=capture` on this machine.** It reports success
> and sends nothing, so the office would record submissions that never left the
> building. It exists for automated tests.

---

## 10. Create the real employee accounts

```powershell
npm run bootstrap-production
```

This prints one generated password per employee, **once**. They are stored only
as hashes and cannot be recovered. Write them on separate slips, hand each
person theirs directly, and have them change it.

The same run **disables the five development accounts** — `telecaller.a`,
`telecaller.b`, `login.exec`, `manager.m`, `partner.p` — and revokes any live
session they hold. That used to require `--reset` plus an
`AOS_BOOTSTRAP_CONFIRM` environment variable, which put the safe outcome behind
two opt-ins and left `partner.p`, a Managing Partner, signable-in by default.
Nothing is deleted: the accounts stay as records so departed names survive on
what they touched (BR-062), and one `update app_user set is_active = true`
reverses it.

Confirm none are left active:

```powershell
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -d aos -c `
  "select username, is_active from app_user order by username"
```

`telecaller.a`, `telecaller.b`, `login.exec`, `manager.m` and `partner.p` must
all read `f`. **Do not put real customer data in AOS until they do.**

---

## 11. Turn on the nightly backup

```powershell
.\Scripts\register-backup-task.ps1 -WhatIf      # look first
.\Scripts\register-backup-task.ps1 -Time 20:30
```

Then prove it, rather than waiting for tonight:

```powershell
Start-ScheduledTask -TaskName "AOS Nightly Backup"
Get-Content "D:\AOS-Backups\backup-log.txt" -Tail 30
npm run backup:verify
```

`backup:verify` must end with "All 1 backup(s) verified." A backup that has
not been verified is a folder.

---

## 12. Make AOS start itself

```powershell
.\Scripts\register-aos-services.ps1 -WhatIf
.\Scripts\register-aos-services.ps1
Start-ScheduledTask -TaskName "AOS Server"
.\Scripts\aos-status.ps1
```

**Then reboot the PC and run `aos-status.ps1` again.** An auto-start that has
never survived a real reboot is not known to work, and the day it matters is
the day nobody is looking.

---

## 13. Record what only you know

Fill in the table at the bottom of `Docs/Deployment Topology.md`: which PC this
is, its IP, the URL employees use, where backups physically live, and who holds
the database password and the login slips.

---

## Everyday operation

| Task | Command |
|---|---|
| Is it working? | `.\Scripts\aos-status.ps1` |
| Restart AOS | `Stop-ScheduledTask -TaskName "AOS Server"` then `Start-ScheduledTask ...` |
| Read the log | `Get-Content Backend\supervisor.log -Tail 50` |
| Back up now | `npm run backup` |
| Check backups are restorable | `npm run backup:verify --all` |
| Update AOS | `git pull; npm ci; npm run migrate; npm run build;` restart the task |

**Practise a restore before you need one.** `npm run restore-drill` rehearses
the whole procedure against throwaway databases and folders — it never touches
`aos` or `C:\AOS\Data`. `Docs/Disaster Recovery.md` is the real thing.
