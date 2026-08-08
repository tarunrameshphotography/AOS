# Frontend — clickable prototype

```
npm install
npm run dev      # http://localhost:5173 — starts Vite AND the local document
                 # storage backend (Backend/storage-server.mjs, port 4319)
                 # together. Uploads need both; `npm run dev` is the only
                 # command you should need for local development.
```

## What this is

A prototype you can use, so the product can be judged before more backend is
written. **The data is fake. The business rules are not.**

Stages, transitions, progress arithmetic, case numbering and permissions all
import from `src/domain/` — the same modules the server will run. If the
prototype refuses something, it refuses for the reason the domain layer gives,
and the reason is shown verbatim rather than replaced with "something went
wrong".

The fake part is `Frontend/src/fake/`: an in-memory store persisted to
localStorage, shaped like the schema in `Database/migrations` so that swapping it
for Supabase is a substitution rather than a translation.

## Things worth trying

**Switch user** (top right). There is no login — switching is how you see the
permission model do something.

- **Priya Raman** (telecaller) — sees only her own cases, but *every* person.
  Open a case and the documents have no Verify button.
- **Karthik V** (login executive) — same case, same URL, now with Verify, Waive
  and a full PAN instead of a masked one.
- **Lakshmi Narayanan** (manager) — everything operational, plus why banks said
  no, grouped by standardised category.
- **Suresh Babu** (finance) — cases and money, no documents at all.
- **Karthik V (also calling)** — one human, two roles, and a workspace switcher.
  Switching workspace changes nothing about what he may do.

**Search** anything: `ravi`, `9843`, `sasi rekha`, `anna nagar`, `iifl`,
`AL-2026-00041`, or just `41`. Each result says *why* it matched.

**Create a case.** Type "Sasi Rekha" — it finds "Sasirekha M" through her alias
and tiers the match. Pick her, and the case opens with her KYC already satisfied,
because documents belong to people rather than to loan applications.

**Case AL-2026-00041** is the interesting one: sanctioned at HDFC, rejected at
IIFL, still under process at LIC — three truths at once. Accept the offer and
watch the others go to *Withdrawn*, not *Rejected*.

**Add a co-applicant** to a case in Documents Pending and watch progress go
*backwards*, with the timeline saying why.

**Reset prototype data** is in the user menu when you have made a mess.

## What is deliberately missing

No auth, no masked views — the PAN masking here is a UI stand-in for what
ADR-026 does in the database. No RLS, because the policies are not written yet.

File storage is real, not simulated: uploads go through `@domain/storage` to
`Backend/storage-server.mjs`, a local Node server that writes the actual bytes
to disk under a configurable root (`AOS_STORAGE_ROOT`, defaulting to
`C:\AOS\Data`). `npm run dev` starts it alongside Vite automatically; if you
ever run Vite alone, uploads will fail with a clear error rather than silently
doing nothing.

Screens not built: appointment scheduling, reporting, admin master-data editing,
merge flows.
