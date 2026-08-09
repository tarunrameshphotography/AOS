# Email and WhatsApp Integration

Operational guide for the Email & WhatsApp Integration milestone. Decisions and
their reasoning are in `DECISIONS.md` (ADR-039); this is what somebody has to
*do*.

---

## What works today

**Sending a case's verified documents to a banker, by email.** From a case →
Banks → a submission → **Send documents via mail**. Choose the documents, review
the emails, confirm. The result, the batches and every document version sent are
recorded on the case and in the timeline.

**WhatsApp is not implemented.** The provider seam exists and nothing behind it
does. See the last section.

---

## The rules the workflow enforces

| Rule | Where it lives |
|---|---|
| Only a **verified** document may be sent | `src/domain/submissions/attachments.ts` |
| A rejected or unverified upload is shown, disabled, with its reason | `Frontend/src/screens/CaseDetail.tsx` |
| A requirement with nothing uploaded never appears | `sendableDocumentsFor` in `Frontend/src/fake/store.ts` |
| **No email exceeds 10 MB of attachments** | `MAX_ATTACHMENT_BYTES_PER_EMAIL`, and a check constraint on `submission_package_email` |
| Every selected document is in exactly one email | `planBatches`, and a unique index on `submission_package_document` |
| A single file over 10 MB stops the send and is named | `describeIneligibility` |
| The current verified version is sent, never a superseded one | the requirement's `satisfiedByDocumentId` |
| Nothing is sent until **Send documents** is pressed | the review step |
| Partial failure is reported as partial | `submission_package.status = partially_sent` |
| A retry resends only the failed emails | `retryDocumentPackage` |

### Why 10 MB

Gmail caps a whole message at 25 MB. Attachments are base64, which is four
thirds of the raw size plus a CRLF every 76 characters, so 10 MB of files
becomes about 13.7 MB on the wire. With MIME overhead that leaves more than
10 MB of headroom under Gmail's limit — asserted by
`src/domain/submissions/attachments.test.ts`, which is the test to read before
anybody raises the number.

---

## Connecting the Amaze Loans mailbox

Done once, by an administrator, signed in as the sending mailbox. Nothing below
is a developer task and nothing below goes in the repository.

### Why OAuth2 and not a password

Google stopped accepting account passwords from applications in 2022, and AOS
must not store one regardless. **A service account will not work here**: domain-
wide delegation only impersonates users in a Google *Workspace* domain, and
`amazeloans@gmail.com` is a consumer account. If Amaze moves to Workspace on its
own domain, the service-account route becomes available and only
`Backend/mail-server.mjs` changes.

### Steps

1. `console.cloud.google.com` → create or pick a project.
2. **APIs & Services → Library** → enable **Gmail API**.
3. **OAuth consent screen** → *External*, add `amazeloans@gmail.com` as a Test
   user.
   **Then publish it.** While the app sits in "Testing", Google expires refresh
   tokens after 7 days and the office will be reconnecting weekly. Moving it to
   "In production" needs no Google review while the only users are your own.
4. **Credentials → Create credentials → OAuth client ID → Desktop app.** This
   gives the client id and client secret.
5. Authorise once with the scope `https://www.googleapis.com/auth/gmail.send` —
   the **send-only** scope; AOS never reads the mailbox — and exchange the code
   for a refresh token. Google's OAuth Playground does this with "Use your own
   OAuth credentials" ticked.
6. Copy `.env.example` to `.env` and fill in:

   ```
   AOS_MAIL_PROVIDER=gmail
   AOS_GMAIL_CLIENT_ID=…
   AOS_GMAIL_CLIENT_SECRET=…
   AOS_GMAIL_REFRESH_TOKEN=…
   ```

7. `npm run dev`. The mail backend prints which provider it is using at startup.
   `GET http://127.0.0.1:4320/health` says the same thing.

The refresh token is a long-lived credential for the Amaze Loans mailbox. Treat
it as you would the password: never commit it, never paste it into a ticket, and
revoke it at `myaccount.google.com/permissions` if it leaks. `.env` is
git-ignored.

### If nothing is configured

Every send is refused with a message saying so, the attempt is recorded, and the
case timeline shows the failure. AOS never reports a send it did not make.

---

## What has and has not been tested

**Tested, automatically:** eligibility, batching, the size ceiling, subject and
body composition, the package/email/document records, the event log,
permissions, partial failure, retry, and the whole UI workflow in a real browser
(`tests/e2e/document-submission.spec.ts`).

**NOT tested automatically: real delivery to a real mailbox.** It needs a live
credential, it is not deterministic, and a suite that depends on Google being up
is one that lies about what it proved. The Playwright suite therefore runs the
mail backend in `capture` mode: each message is built exactly as a real send
builds it — same MIME, same base64, same headers — and written to disk instead
of being delivered. The tests then read those files back.

`capture` is enabled only by setting `AOS_MAIL_PROVIDER=capture` explicitly. It
must never be set on an office install: the timeline would record submissions
that never left the building.

### The manual check, after connecting a mailbox

Do this once, on the machine that has the credentials:

1. Open a real case with at least two verified documents.
2. Add a bank, addressed to **your own** email address.
3. Send documents. Confirm the review screen first.
4. Check the mailbox: subject, greeting, body, attachment count, and that the
   attachments open.
5. Check the case timeline says *Documents sent to banker*.
6. Repeat with enough documents to exceed 10 MB and confirm the numbered emails
   arrive and that between them they carry every document once.

Only after that has been done against a real mailbox should anybody say email
delivery works.

---

## WhatsApp

**Not implemented. Nothing is faked.**

The seam is `src/domain/communications/whatsapp-provider.ts`. It is deliberately
shaped around **pre-approved templates with positional parameters**, not free
text, because a business-initiated WhatsApp message outside the 24-hour service
window cannot be free text — an interface accepting `body: string` would compile
and then fail at the provider on every call.

### What it is for, and what it is not

Suitable — the customer side, where email is the weak channel:

* Document requests: the outstanding checklist, sent to the applicant.
* Missing-document reminders.
* Case status updates.
* Appointment and follow-up confirmations.

**Not suitable: sending documents to a banker.** That is the email workflow.
A WhatsApp document message carries one file, has no subject, no cc and no
thread a colleague can be added to, and it lives on one person's handset rather
than in a branch mailbox.

### Forbidden, permanently

WhatsApp Web automation, browser scraping, QR-session hijacking and every
"personal WhatsApp" library. They breach Meta's terms, they get the office's
actual working number banned, and they cannot be audited. The only acceptable
implementation is the **WhatsApp Business Cloud API**, or a BSP reselling it.

### What an administrator must obtain first

Mirrored from `WHATSAPP_REQUIRED_CONFIGURATION` in the provider file, which is
the source of truth:

| Needed | Notes |
|---|---|
| Verified Meta Business account | Business verification needs company documents; takes days. |
| WhatsApp Business Account with a registered number | That number then stops working in the WhatsApp / WhatsApp Business handset apps. |
| `AOS_WHATSAPP_PHONE_NUMBER_ID` | The Cloud API's id for the number, not the number. |
| `AOS_WHATSAPP_ACCESS_TOKEN` | System-user token with `whatsapp_business_messaging`. A developer token expires in 24 hours and must not be used for anything real. |
| Approved message templates | One per workflow. Each is reviewed by Meta. |
| A public HTTPS webhook | For delivery receipts and replies. **AOS has none** — both local backends bind to `127.0.0.1`. |
| Customer opt-in, recorded | Meta requires it and Indian data-protection practice expects it. **AOS has no field for this yet.** |

The last two are the real blockers, and neither is solved by writing code.

---

## Files

| File | What it does |
|---|---|
| `src/domain/submissions/attachments.ts` | Eligibility, the 10 MB ceiling, the provider-limit arithmetic. |
| `src/domain/submissions/batching.ts` | Reading groups, ordering, the split. |
| `src/domain/submissions/compose.ts` | Subject, greeting, body. No model involved. |
| `src/domain/submissions/package.ts` | The three above, composed into what the user reviews. |
| `src/domain/communications/email-provider.ts` | The `EmailProvider` seam and typed failures. |
| `src/domain/communications/whatsapp-provider.ts` | The WhatsApp seam and the configuration list. |
| `Backend/mail-server.mjs` | MIME, Gmail OAuth2, the capture provider, the refusing default. |
| `Frontend/src/fake/mail.ts` | The frontend's provider — HTTP to the backend. |
| `Frontend/src/fake/store.ts` | Prepare, send, retry, and the records they write. |
| `Frontend/src/screens/CaseDetail.tsx` | The Banks tab action and the three-step dialog. |
| `Database/migrations/0030_document_submission_by_email.sql` | The four tables. |
