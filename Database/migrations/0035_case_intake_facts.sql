-- ===========================================================================
-- 0035 — Case intake facts, artifact classification, and the rules both fix
--
-- THE PROBLEM THIS MIGRATION IS HALF OF
--
-- Since 0021 the requirement engine has been able to ask about a party's
-- employment type, borrower type and business constitution, and about the
-- case's GST registration and existing obligations. Since 0023/0026/0027 the
-- rule pack has read those facts properly: salaried gets payslips and Form 16,
-- self-employed gets ITR, Form 26AS, CA-certified accounts and GST returns.
--
-- Nothing ever WROTE those facts. `createCase` took an applicant, a product,
-- an amount and a source; `case_party.employment_type_id` was writable only
-- through Phase 4's party-profile endpoint, which no screen called. So on
-- every real case `party.employment_type` resolved to unknown, every
-- employment-conditioned rule matched nothing, and the checklist that reached
-- the login desk was KYC plus whatever the product code alone could justify.
-- The engine was not wrong. It was never told anything.
--
-- The application half of the fix is the New Case screen, which now asks the
-- handful of questions the telecaller is already asking on the call
-- (Frontend/src/screens/NewCase.tsx, Backend/cases.ts). This half is the two
-- facts that had no column, plus two corrections the same review surfaced.
--
-- ADDITIVE, as every migration since 0021 has been. Two nullable columns on
-- `case_party`, one defaulted column on `document_type`, and data changes to
-- rule rows that are master data and editable in the Document Rules screen
-- anyway. No column is dropped, no historical requirement is rewritten, and
-- no generated row is deleted (BR-003, BR-034).
--
-- The RULE data below is GENERATED from src/domain/requirements/default-rules.ts
-- and document-catalogue.ts, which stay authoritative — same discipline as
-- 0022, 0023, 0026 and 0027. Regenerate rather than edit by hand.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Two facts about a party that had nowhere to live.
--
-- Both are DELIBERATELY NULLABLE and three-valued, for the reason 0021 gives
-- for `loan_case.is_gst_registered`: null is "nobody has asked yet", which is
-- a different fact from "no", and a rule that conflates them fires (or stands
-- down) on every half-filled case.
-- ---------------------------------------------------------------------------

alter table case_party
  add column itr_filed         boolean,
  add column is_gst_registered boolean;

comment on column case_party.itr_filed is
  'Does this party file an income tax return? Recorded at intake because the '
  'telecaller is already asking. Read by party.itr_filed, which the ITR rules '
  'use through `not_equals false`: they fire on YES and on UNKNOWN, and stand '
  'down only when a human has actually said no. A return that was never filed '
  'cannot be collected, and a requirement that sits pending forever is how a '
  'checklist stops being read — but an UNANSWERED question must never suppress '
  'the one document a self-employed file is assessed on.';

comment on column case_party.is_gst_registered is
  'This party''s own GST answer, for THIS case. Null falls back to '
  'loan_case.is_gst_registered (see resolveFact in '
  'src/domain/requirements/rules.ts) — a proprietor and their firm are '
  'GST-registered as one fact in practice, and asking twice is how two sources '
  'of truth begin. The column exists for the case where they genuinely differ: '
  'a GST-registered applicant with a salaried co-applicant who has no GSTIN.';

-- ---------------------------------------------------------------------------
-- 2. Who produces a document — and therefore whether AOS may put it on a
--    customer's collection list at all.
--
-- Mirrors DOCUMENT_ARTIFACT_KINDS in src/domain/requirements/document-catalogue.ts,
-- which is authoritative. Text with a check constraint rather than an enum,
-- matching `document_requirement_rule.party_kind` (0021): the list is short,
-- closed in the domain layer, and adding a value should not cost a type
-- rewrite.
--
-- Defaulted to 'customer' so every one of the ninety-odd existing types keeps
-- exactly the meaning it had. Three rows change, below.
-- ---------------------------------------------------------------------------

alter table document_type
  add column artifact_kind text not null default 'customer'
    check (artifact_kind in ('customer', 'bank_submission', 'internal'));

comment on column document_type.artifact_kind is
  'Who produces this document. `customer` — the customer hands it over, and it '
  'is the only kind a requirement rule may ask a telecaller to collect. '
  '`bank_submission` — the lender''s own form, which does not exist until a '
  'lender is chosen (login form, NACH mandate); it belongs to the submission '
  'workflow. `internal` — Amaze''s own paperwork. A CLASSIFICATION, not an '
  'enforcement: nothing here deletes a type or a historical requirement, and '
  'all three kinds remain uploadable against a case as Additional Documents. '
  'See DOCUMENT_ARTIFACT_KINDS in src/domain/requirements/document-catalogue.ts.';

update document_type set artifact_kind = v.kind
from (values
  ('login_form',       'bank_submission'),
  ('nach_mandate',     'bank_submission'),
  ('application_form', 'internal')
) as v(code, kind)
where document_type.code = v.code;

-- ---------------------------------------------------------------------------
-- 3. Retire the three rules that put those artifacts on a customer's list.
--
-- WHY THIS IS A FIX AND NOT A PREFERENCE. All three generated a case-scoped
-- requirement on every file. None of them could ever be satisfied by a
-- collection call: two are forms the lender issues once a lender is chosen,
-- and one is Amaze's own. Live use answered them the only way it could — by
-- waiving them. A waiver means "this file goes to the bank with a known gap,
-- and my name is on that decision" (BR-035). Spending it on a row that was
-- never the customer's to supply devalues every genuine waiver on the case,
-- and teaches the login desk that waiving is how you tidy a list.
--
-- is_active = false, NOT a delete and NOT applicability = 'not_applicable'.
-- The three mean different things (0021's own comment on
-- `document_requirement_rule.applicability_id`): 'not_applicable' is "this
-- situation does not need the document", which is a statement about a case;
-- `is_active = false` is "this rule is not in service", which is the statement
-- being made here. The rows stay readable in the Document Rules screen, with
-- the reason on them, and a business user who disagrees turns one back on
-- without a deploy.
--
-- Requirements ALREADY generated by these rules are untouched by this
-- migration. They retire themselves the ordinary way: `regenerateRequirements`
-- (Backend/requirements.ts) no longer plans them, so the next read of the case
-- marks them `not_applicable` — kept, excluded from progress, never deleted
-- (BR-034). A row someone already waived keeps its waiver and its history.
-- ---------------------------------------------------------------------------

update document_requirement_rule r
   set is_active = false,
       notes     = v.notes
from (values
  ('case_application_form',
   'RETIRED — internal artifact. Amaze''s own application form is filled by Amaze, not collected from the customer, so it does not belong on a collection call''s list.'),
  ('case_login_form',
   'RETIRED — bank submission artifact. The lender''s own form, which does not exist until a lender is chosen and is not the customer''s to supply. It belongs to the submission workflow, which knows the lender; asking for it here made every case carry a row nobody could ever satisfy.'),
  ('case_nach_mandate',
   'RETIRED — bank submission artifact. The mandate is the lender''s form on the lender''s format, signed at sanction. Same reasoning as the login form.')
) as v(code, notes)
where r.code = v.code;

-- ---------------------------------------------------------------------------
-- 4. The ITR rules stand down when — and only when — the customer does not file.
--
-- `not_equals 'false'` rather than `is_true`, and the difference is the whole
-- point. `is_true` would fire only after somebody ticked yes, so a case opened
-- five minutes ago would ask a self-employed borrower for no ITR at all — the
-- exact failure the 0026 audit found on the GST rules and fixed there. This
-- fires on YES and on UNKNOWN and stands down only on an explicit NO.
--
-- Booleans compare as the text 'true' / 'false' (see toComparable in
-- src/domain/requirements/rules.ts), which is why the literal below is a
-- string.
--
-- display_order 40: after each rule's existing conditions, which run 10–30.
-- ---------------------------------------------------------------------------

insert into document_requirement_rule_condition (rule_id, fact, operator, values, display_order)
select r.id, 'party.itr_filed', 'not_equals'::app.rule_condition_operator, array['false'], 40
from document_requirement_rule r
where r.code in ('income_itr', 'income_itr_business_promoter')
  and not exists (
    select 1 from document_requirement_rule_condition c
     where c.rule_id = r.id and c.fact = 'party.itr_filed'
  );

update document_requirement_rule
   set notes = 'Two assessment years with computation; the market standard (ICICI''s published LAP checklist asks for exactly that). Stands down only where the intake recorded that the customer does not file — a return that does not exist cannot be collected, and leaving it pending forever is how a checklist stops being read.'
 where code = 'income_itr';
