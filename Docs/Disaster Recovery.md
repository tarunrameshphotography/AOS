# Disaster Recovery

What to do when the office server PC, its disk, or the database is gone.

Read this **before** you need it. The procedure has been rehearsed — see
"Proof this works" at the bottom — but rehearsing it yourself once, on a quiet
afternoon, is worth more than reading it twice.

---

## First: do not make it worse

1. **Do not delete anything.** Not the database, not `C:\AOS\Data`, not a
   backup folder that "looks corrupt". A damaged database is often still
   partially readable and is evidence about what happened.
2. **Do not run migrations** against a database you are unsure about.
3. **Take a copy of the backup folder you intend to restore from** before
   restoring, if there is room. A restore reads it, but a failed restore
   attempt followed by a panicked second attempt is where backups get lost.
4. Note the time and what happened. Ten minutes of memory is worth more than an
   hour of reconstruction later.

---

## What AOS data actually is

Two halves that must be restored **from the same backup run**:

| | Where | What it is |
|---|---|---|
| Operational database | PostgreSQL `aos` | Customers, cases, requirements, document *metadata*, verification, submissions, users, permissions, the event log |
| Document bytes | `AOS_STORAGE_ROOT` (`C:\AOS\Data`) | The actual PDFs and photos |

`document.file_path` in the database is a *pointer*. A database restored
without its matching documents is a system that believes in files it cannot
open; documents restored without their database are bytes nobody can find.
`Backend/backup.mjs` writes both into one timestamped folder for exactly this
reason — **never mix a database dump from one run with documents from another.**

Not in the backup, because it is not derived data: `.env`. It holds the
database password and the Gmail refresh token. Keep a copy somewhere secure and
offline. Everything else can be rebuilt from this repository.

---

## Scenario A — the database is corrupt or was dropped, the PC is fine

1. Confirm what you are restoring from:

   ```powershell
   cd C:\AOS\App
   npm run backup:verify -- --all
   ```

   Pick the newest run that verifies. If none do, use the newest that verifies
   with only document problems — a good dump with some missing files is far
   better than nothing.

2. Restore. Note `AOS_RESTORE_CONFIRM`: without it the script refuses to write
   to the office database at all.

   ```powershell
   $env:AOS_RESTORE_CONFIRM="aos"
   node Backend/restore.mjs `
       --backup "D:\AOS-Backups\2026-08-10_20-30-00" `
       --db aos `
       --storage-root C:\AOS\Data `
       --create-db --drop-existing --overwrite-storage
   ```

   `--drop-existing` destroys the current `aos` database. That is the intent
   here, and it is why the confirmation variable exists. **Only run this when
   you have decided the current database is not worth keeping.**

3. Check the tail of the output: "all N restored document(s) match the backup
   byte for byte". If it reports missing or corrupted files, the database is
   restored but some documents are not — see "Partial document loss" below.

4. Start AOS and check it:

   ```powershell
   Start-ScheduledTask -TaskName "AOS Server"
   .\Scripts\aos-status.ps1
   ```

5. Open a case that had documents and download one. That is the only check that
   proves both halves came back together.

---

## Scenario B — the server PC is dead

You need the backup folder (from wherever `AOS_BACKUP_ROOT` pointed) and the
`.env` copy.

1. Follow `Docs/Installation.md` steps 1–4 on the replacement PC — Node,
   PostgreSQL, the checkout, `npm ci`, and `.env`.
2. **Do not run `npm run migrate`.** The restore brings the schema with it, and
   migrating first produces a database the dump cannot be applied cleanly onto.
3. Create the database and restore:

   ```powershell
   $env:AOS_RESTORE_CONFIRM="aos"
   node Backend/restore.mjs `
       --backup "<backup folder>" --db aos `
       --storage-root C:\AOS\Data --create-db
   ```
4. `npm run build`, then continue from Installation step 7.
5. `npm run migrate:status` — if the checkout is newer than the backup, some
   migrations will show as pending. Apply them with `npm run migrate`.
6. Re-do Installation steps 8, 11 and 12: firewall, backup task, server task.
   None of those live in the backup.
7. **The LAN IP of the new PC is probably different.** Reserve the old address
   for it if you can; otherwise tell everyone the new URL and update
   `Docs/Deployment Topology.md`.

---

## Scenario C — someone deleted a case, or a document, by mistake

There is no undelete, and there is deliberately no "restore one row" path: a
row lifted out of a backup and pushed into a live database arrives without the
events, requirements and submissions that referenced it.

What to do instead:

1. Restore the relevant backup into a **scratch** database and folder — never
   over the live one:

   ```powershell
   node Backend/restore.mjs --backup "<run>" --db aos_recovery `
       --storage-root C:\AOS\Recovery --create-db --drop-existing
   ```
2. Read what you need out of `aos_recovery` with `psql`, and copy the document
   files you need out of `C:\AOS\Recovery\Documents`.
3. Re-enter the work in the live system through the normal screens, so it
   carries correct events and ownership.
4. Drop `aos_recovery` and delete `C:\AOS\Recovery` when done.

Note that most "deletions" in AOS are not deletions: cases are marked lost and
can be reopened, requirements become `not_applicable` rather than disappearing,
users are deactivated rather than removed, and the event log cannot be modified
at all (a database trigger refuses `UPDATE` and `DELETE` on it). Check whether
the thing is actually gone before restoring anything.

---

## Partial document loss

If a restore reports missing or mismatched document files, the database is
consistent but some bytes are gone. Those requirements will show as verified
with a document that cannot be downloaded.

1. Note which paths failed — the restore prints the first five and counts the
   rest.
2. Check an older backup: `npm run backup:verify -- --all` and look for a run
   where those files verify.
3. If no backup has them, the documents must be collected from the customer
   again. Find the affected cases by matching `document.file_path` against the
   failed paths.

---

## Proof this works

`npm run restore-drill` runs the entire procedure end to end against throwaway
targets — it builds a synthetic case with a real uploaded document through the
ordinary code paths, backs it up, **deliberately corrupts a copy to confirm the
verifier rejects it**, restores into a scratch database and folder, and checks
that the case, the document metadata, the requirement linkage, the audit trail
and the document bytes all came back. It never touches `aos` or `C:\AOS\Data`.

Last run: 16/16 checks passed, including both damage-detection cases. The
report is written to `<AOS_BACKUP_ROOT>\..\DrillBackups\last-drill-report.md`.

Run it after any change to the backup or restore scripts, and once a quarter
regardless.
