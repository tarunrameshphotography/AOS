# Identity Resolution

**Status:** Draft for review.

The company's hardest operational problem is not process. It is *remembering*.
Who was that customer. Was he here before. Is this the same business. Which case
was the Madurai one. Today the answer lives in one person's head, and when that
person is on leave the answer does not exist.

**Design goal: no employee should ever need to remember the correct name of
anything.** They type what they remember — a fragment, a misspelling, a place, a
phone number's last four digits — and AOS finds it. The system holds the correct
name so that humans don't have to.

---

## Part 1 — How people actually refer to things

Observed from the way the business talks:

| They say | It means |
|---|---|
| "Ravi's case" | A person's first name only. There are four Ravis. |
| "the Madurai file" | A *place* — the property's locality, not stored on the case at all in most designs. |
| "that textile loan" | The employer's industry. |
| "the IIFL one" | The bank it went to. |
| "Sasi Rekha... or was it Sasirekha" | Spelling variance in transliterated names. |
| "R. Tarun" / "Tarun R" | Initials that expand to a father's name, ordered either way. |
| "the guy Murugan referred" | Identified only by the referrer. |
| "9843..." | A partial phone number. |

Every one of these must work as a search. This is not a nice-to-have; it is the
product's central promise.

---

## Part 2 — Principles

1. **Search tolerates error. Data does not.** Input is forgiving; storage is
   canonical.
2. **Never block on ambiguity.** When identity is uncertain, present the
   candidates and let a human decide. Never silently merge, never hard-refuse.
3. **Aliases are first-class.** Every wrong-but-used name is recorded, not
   corrected away. The wrong name is how people will search next time.
4. **Recognition is a feature, shown loudly.** When a repeat customer is
   detected, say so — "3 previous cases, KYC on file" — because that moment is
   where the system visibly beats memory.
5. **Merging never loses history.** A merge is a recorded event, and it is
   reversible.

---

## Part 3 — Person identity

### Identity is an ID. Identifiers are evidence.

*This section supersedes the first draft, which made phone the natural key. That
was wrong — see ADR-013.*

Every person has a **Person ID**: system-generated, permanent, meaningless. It is
never derived from any real-world attribute, and it never changes — not when the
person changes their number, corrects their name, or is merged into another
record.

Everything else — phone, PAN, email, Aadhaar — is an **identifier**: evidence
that helps recognise a person, held in a separate multi-valued table.

Why phone cannot be identity, in order of severity:

1. **Numbers are recycled.** In India a disconnected mobile number is reissued.
   A number that identified a customer in 2024 can belong to a stranger in 2027 —
   who would silently inherit that customer's cases, documents and communication
   history. This is data corruption that looks like normal operation.
2. **Numbers are shared.** One family phone, one office landline. Identity-by-
   phone fuses distinct people into one record.
3. **Numbers change.** Under an identity-by-phone model, that is an identity
   change, which should be impossible by definition.

### The identifier table

`person_identifier` — person_id, type, raw value, normalised value, is_primary,
valid_from, valid_to, verification source (self-declared / seen on document /
verified against issuer), added_by.

Validity periods are what make recycled and transferred numbers safe: a call
logged in 2024 is attributed to whoever held that number in 2024, not to whoever
holds it now.

### Identifiers are not equal

The model must know *how* each type behaves, because matching logic depends on it:

| Identifier | Exclusive to one person? | Strength | Notes |
|---|---|---|---|
| **PAN** | Yes | Very strong | Near-definitive when read off a document. Best identifier this market offers. |
| **Aadhaar** | Yes | Very strong | Legally constrained — see open questions. |
| **Phone** | **No** | Strong, time-bound | Shared and recycled. Never definitive alone. |
| **Email** | Mostly | Medium | Frequently absent in this customer base. |
| **Bank account** | No — joint accounts | Medium | Supporting evidence only. |
| **Date of birth** | No | Weak | Only ever a tie-breaker. |
| **Name** | No | Weak | Never a key. See Part 3 below. |

### Matching is a score, not a lookup

Recognition combines identifiers rather than trusting one:

- Verified PAN match → definite, on its own.
- Phone match **plus** name similarity → definite.
- Phone match **with a conflicting name** → probable, not definite. This is the
  family-phone and recycled-number case, and it must prompt rather than assume.
- Name similarity plus locality, or plus shared referrer → probable.
- Name similarity alone → possible.

The rule that falls out of this: **no single non-exclusive identifier ever
produces a definite match by itself.** Only PAN and Aadhaar can do that alone,
and only when their source is a document rather than someone's memory.

### Why name is never a key

The one part of ADR-012 that survives. Names are the weakest identifier in this
market, for reasons that are structural rather than accidental:

- Transliteration has no single correct spelling: Sasi Rekha / Sasirekha /
  Sashirekha are one person.
- Tamil naming convention frequently has no surname; the initial is the father's
  name, and it moves between the front and the back depending on the form.
- The same person appears as "R. Tarun", "Tarun Ramesh", and "Tarun R".

Name is a *search* input and a *display* value. Never a key, never a match on its
own.

A consequence worth stating because someone will otherwise "fix" it in the
migration: **`person.full_name` is nullable.** A person redacted under ADR-018
becomes a tombstone with their personal columns nulled in place, while the cases,
events and stage history that reference them survive without personal content. A
`NOT NULL` on the name would make erasure impossible without deleting the row,
which is precisely what must not happen.

### Alias handling

`person_alias` — person_id, alias text, source (typed by user / from a document /
previous spelling), created_by.

Aliases are created automatically whenever a name is entered that does not match
the canonical one but resolves to the same person, and manually when someone
knows a customer by another name. Search covers aliases equally with canonical
names.

### Duplicate detection, three tiers

Applied at the moment a new person is being created:

| Tier | Trigger | Behaviour |
|---|---|---|
| **Definite** | Document-verified PAN or Aadhaar match; or phone match **with** a similar name | Do not create. Open the existing person. Overriding requires a reason and writes an event. |
| **Probable** | Phone match with a *conflicting* name (family phone, recycled number); similar name + same locality; similar name + shared referrer | Show candidates inline: "Possibly Ravi Kumar, 2 cases, last seen March 2026." User chooses existing or confirms new. |
| **Possible** | Fuzzy name match only | Create silently, but flag the pair for later review in an admin duplicates queue. |

Note that a bare phone match is deliberately **not** definite on its own — that
is the family-phone and recycled-number case, and assuming identity there is how
one person's history ends up attached to another's.

The cost asymmetry matters: a missed duplicate is a permanent data wound; a false
warning costs two seconds. Bias toward warning.

---

## Part 4 — Organisation identity

**Recommendation: model Organisation as a lightweight entity from V1.**
This reverses the position in the first Data Model draft. Reasoning in ADR-009.

Applying the four-question test:

- *What real problem does it solve today?* Business borrowers. For business loans
  and LAP the applicant may be a firm, holding its own GST certificate, ITR and
  financials. That entity has to exist regardless of the employer question.
- *What future problem does it prevent?* Converting years of dirty free-text
  employer names into an entity by hand. This is the expensive class of
  migration, and it gets worse every month it is deferred.
- *What complexity does it add?* One table, one alias table, one foreign key. The
  real risk is UI friction, not schema.
- *Is it justified today?* Yes, provided the UI friction is zero — see below.

### Keeping it invisible

Users never "create an Organisation." They type a name into an employer or
business field. AOS matches against existing organisations and their aliases,
offers the best match, and if there is none, creates the record silently in the
background. The typing experience is identical to a plain text field. The
difference is only in what gets stored.

### One organisation model, with roles

Every non-human party is an organisation: employers, borrowing firms, builders,
developers, vendors, **banks and branches**. Roles are flags, not tables, because
they overlap constantly — a construction firm is a builder on one case, a vendor
on another, and somebody's employer on a third. Separate tables would store that
firm three times, which is the exact problem ADR-006 solved for people.

`organisation` — canonical name, roles (employer / borrower / builder /
developer / vendor / lender / branch), industry, city, parent_organisation_id,
active.
`organisation_alias` — organisation_id, alias text, source.
`lender_profile` — organisation_id, panel status, products offered, standard
turnaround, notes. Extension table, mirroring `referrer_profile` on people.

**Including banks is the point, not an accident.** "IIFL" / "IIFL Home Finance
Ltd" / "India Infoline" is precisely the same alias problem as "ABC Textiles". By
making lenders organisations, the alias table, fuzzy matching, merge and
tombstone-redirect all apply to banks with no additional machinery.

Not in V1: general hierarchies, parent companies and groups, contact directories,
full addresses. `parent_organisation_id` exists for exactly one purpose — branch
to bank — and must not be quietly repurposed.

### Vocabulary rule

**The word "Organisation" never appears in the interface.** Users see Bank,
Branch, Builder, Employer. The generic model is a schema fact and stays in the
schema. A screen that asks a telecaller to "select an organisation" has leaked
the abstraction and is a bug.

### Similar-name detection

Legal suffixes (Pvt Ltd, Private Limited, & Co, Enterprises, Traders) are
stripped before comparison, so "ABC Textiles" and "ABC Textiles Pvt Ltd" collide
as expected. Near-matches surface as suggestions to the user, and as a periodic
admin merge queue. They are never auto-merged — "Sri Lakshmi Traders" and "Sri
Lakshmi Textiles" are plausibly different businesses, and only a human knows.

**The escape hatch is mandatory.** Background resolution is right almost always,
which is exactly why the exception must be easy: two genuinely unrelated firms
share a name more often than intuition suggests, especially with common
devotional and family names. Every resolution prompt therefore carries a "this is
a different company" option that creates a distinct organisation without argument
and records the user's assertion as an event. Silent resolution with no way to
disagree would quietly fuse two customers' employers and nobody would notice.

---

## Part 5 — Property identity

The hardest of the four, because **property has no reliable natural key.** The
same flat is described as "Flat 3B, Green Meadows, Anna Nagar" by the customer,
by survey number on the sale deed, and by a different door number after municipal
renumbering.

Approach:

- Store all identifiers we have, none of them mandatory: door/flat number,
  building or project name, locality, city, pincode, survey number, document
  registration number.
- **Locality is the field to fight for**, because "the Madurai file" is how
  people actually search. It should be structured and autocompleted, not free
  text buried in an address blob.
- Duplicate detection: survey number or registration number match is a strong
  signal and prompts. Address similarity is a weak signal and only suggests.
- Never auto-merge properties. The financial consequence of wrongly linking two
  properties is far worse than a duplicate row.

Accepted limitation: property duplicates will exist. That is tolerable, because
properties are found *through* their case and their people, which are well
identified.

---

## Part 6 — Case identity

A case has a **case number** in the form `AL-2026-00042` — sequential within the
calendar year, human-readable, quotable on the phone, and allocated at creation
including for leads. It is **never the primary key**: the case's identity is its
UUID, and nothing joins on the number (ADR-024).

Nobody searches by it *often*. But people do quote it back, and they quote it
partially and inconsistently, so all of these must resolve to the same case:

| Typed | Read as |
|---|---|
| `AL-2026-00042` | The canonical form |
| `al-2026-42` | Case-insensitive, unpadded |
| `2026-00042` | Year and sequence, prefix dropped |
| `00042` / `42` | Bare sequence, in the current year |
| `#42` | The legacy `#1042` display handle |

A bare four-digit number is treated as a sequence rather than a year: someone
typing `2026` alone is not looking for one case. Implemented in
`resolveCaseNumberInput` (`src/domain/case/case-number.ts`), and an input that is
not case-number-shaped falls through to ordinary text search rather than
returning nothing.

What people search by is everything *around* the case. So each case maintains a
derived search handle and index built from:

- every party's name and alias (applicant, co-applicant, guarantor, referrer)
- the property's locality and building name
- the loan type
- every bank it has been submitted to
- the employer or borrower organisation
- the owner's name

This makes all of these work: *"Ravi home loan"*, *"Madurai"*, *"IIFL rejected"*,
*"textile"*, *"case Murugan referred"*.

Cases also support **user-applied tags** — free labels for the things no schema
anticipates ("NRI", "urgent", "builder tie-up"). Tags are shared across the team,
not private, so one person's shorthand becomes everyone's.

Display handle, generated, never typed:
`AL-2026-01042 · Ravi Kumar · Home Loan · Anna Nagar · HDFC`

---

## Part 7 — Search behaviour

**One search box.** Not a person search and a case search and a document search.
One box, mixed results, grouped by type.

It must handle:

| Input | Resolves via |
|---|---|
| `9843` | Phone suffix, any person |
| `sasirekha` | Alias / fuzzy name |
| `ravi anna nagar` | Multiple weak terms combined |
| `AL-2026-00042`, `2026-00042`, `00042`, `42` | Case number, in any of its quoted forms |
| `iifl sanctioned` | Bank + submission status |
| `abc textiles` | Organisation, and everyone employed there |

Ranking, in order of weight: exact identifier match, then cases the searcher owns,
then recency of activity, then fuzzy strength. A telecaller's own open cases
should surface above a colleague's closed ones for the same query.

Typo tolerance is required, not optional. Phonetic matching tuned for
transliterated Indian names, not the default English-language algorithm — Soundex
on "Sasirekha" is close to useless.

---

## Part 8 — Merge strategy

Merging is inevitable; duplicates will be created. It must be safe.

1. Merge is always **human-initiated and human-confirmed**, with both records
   shown side by side.
2. One record is chosen as the survivor. Field-level choices where they conflict.
3. All relationships — cases, documents, communications, events — repoint to the
   survivor.
4. The merged record is **not deleted**. It becomes a tombstone that redirects:
   old links, old case references and old searches still resolve, and land on the
   survivor.
5. The losing record's name is automatically added as an **alias** of the
   survivor. The "wrong" spelling stays searchable forever, because that is what
   somebody typed and will type again.
6. The merge is one event carrying the complete before-state of both records,
   which makes it **reversible**.

Merging organisations follows the same rules. Merging properties requires an
extra confirmation and is expected to be rare.

---

## Part 9 — History preservation

Non-negotiable, and it applies to every rule above:

- Nothing is deleted to resolve an identity problem. Records are merged,
  redirected or deactivated.
- Every merge, alias addition and duplicate override is an event with an actor
  and a timestamp.
- A person's timeline survives merging intact — communications and cases from
  both original records appear in one chronology.

---

## Part 10 — Open questions

1. **Who may merge?** Merging is destructive-feeling and consequential.
   Management and admin only, or login executives too?
2. **Duplicate review queue** — is anyone realistically going to work it? If not,
   the Possible tier should warn inline instead of queueing, because an unworked
   queue is worse than no queue.
3. **Search over document contents** — do we index the text inside uploaded PDFs
   in V1, or only metadata? This is a meaningful scope difference.
4. **Phone number sharing.** Resolved by ADR-013: a bare phone match is Probable,
   not Definite, and is only promoted to Definite when the name also agrees.

5. **Aadhaar — store, mask, or neither?** Still the most urgent open question in
   the whole PRD, and now more pointed: the identifier model *can* hold Aadhaar
   as a very strong match signal, but whether it lawfully *should* is not an
   architectural question. Under the Aadhaar Act, storage by a private entity is
   tightly restricted, and the safe default is to keep only the document image
   with a masked number and never use it as a match key. Needs a legal answer
   before the schema is built. Until then, design assumes PAN is the strongest
   available identifier.

6. **Identifier verification sources.** Is "seen on a document" recorded by the
   verifying employee enough, or do we eventually want issuer verification (PAN
   API, bank penny-drop)? Affects how much weight the matching score can safely
   place on an identifier.
