-- ===========================================================================
-- 0028 — Customer profile fields and business GST/Udyam record
--
-- A telecaller could see a customer's date of birth and locality but could
-- not correct either, could not record a residential address at all (though
-- `person` has carried `address_line`/`pincode` since 0002), and had nowhere
-- to put a business's own address or its GST/Udyam registration. This
-- migration adds exactly what the frontend prototype's customer-profile
-- milestone needs and nothing already present.
--
-- WHAT ALREADY EXISTED AND IS NOT TOUCHED HERE: person.address_line,
-- person.locality, person.city, person.pincode, person.date_of_birth (0002).
-- organisation.city (0003). This migration only adds what was genuinely
-- missing.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- person — district and state, as free text
--
-- Matches the precedent already set by loan_case.source /
-- loan_case.referral_source_id (0004, 0012): a free-text field first, a
-- master-data link later if the business ever needs one. `district` and
-- `city` master-data tables exist (0012) but are not yet referenced by
-- person.city either — see 0014's own comment — so linking district here
-- would be a bigger step than this milestone needs, not a smaller one.
-- ---------------------------------------------------------------------------

alter table person
  add column district text,
  add column state     text;

comment on column person.district is
  'Free text, deliberately. Matches loan_case.source before referral_source_id '
  'existed: a plain answer now, with a master-data link a later, separate '
  'decision. Not yet referenced by the district master-data table (0012).';

comment on column person.state is
  'Free text, for the same reason as person.district.';

-- ---------------------------------------------------------------------------
-- organisation — address, and GST/Udyam as PROFILE facts
--
-- Address mirrors what person already carries (0002): a business has a
-- location the way a person has a residence, and nothing in the schema
-- modelled it before now.
--
-- is_gst_registered / gstin / udyam_registered / udyam_number are facts
-- ABOUT THE BUSINESS, independent of any one loan application — the same
-- relationship Employment already has to a case (a person's job does not
-- change because they open a second loan). They are explicitly NOT the same
-- fact as loan_case.is_gst_registered (0021), which the Document Requirement
-- Engine reads to decide what to ask for on ONE case. Nothing in the engine
-- may read these four columns: they exist for the customer profile screen
-- only. Keeping the two answers distinct, rather than collapsing them into
-- one, is deliberate — a business's own record and what was recorded for one
-- case are allowed to disagree, and the profile says so rather than hiding
-- it.
-- ---------------------------------------------------------------------------

alter table organisation
  add column address_line     text,
  add column locality         text,
  add column pincode          text,
  add column district         text,
  add column state            text,
  add column is_gst_registered boolean,
  add column gstin            text,
  add column udyam_registered boolean,
  add column udyam_number     text;

comment on column organisation.address_line is
  'The business''s own address. Mirrors person.address_line (0002).';

comment on column organisation.locality is
  'Mirrors person.locality (0002).';

comment on column organisation.pincode is
  'Mirrors person.pincode (0002).';

comment on column organisation.district is
  'Free text, for the same reason as person.district.';

comment on column organisation.state is
  'Free text, for the same reason as person.state.';

comment on column organisation.is_gst_registered is
  'A PROFILE fact about this business, not a case fact. Deliberately distinct '
  'from loan_case.is_gst_registered (0021), which the Document Requirement '
  'Engine actually reads to decide what a given case is asked for — this '
  'column must not be wired into that evaluation. Three-valued: null is '
  '"not recorded", matching the loan_case column''s own convention.';

comment on column organisation.gstin is
  'The GSTIN on the business''s own record, informational. Not validated or '
  'read by any rule.';

comment on column organisation.udyam_registered is
  'A PROFILE fact, for the same reason as is_gst_registered. The Document '
  'Requirement Engine asks for the Udyam certificate as a DOCUMENT '
  '(document_type.code = ''udyam_certificate''), never by reading this column.';

comment on column organisation.udyam_number is
  'The Udyam registration number on the business''s own record, informational.';

-- ---------------------------------------------------------------------------
-- loan_case — who originated it, distinct from who currently owns it
--
-- created_by has existed since 0004 and was never populated by the frontend
-- prototype, which set owner_user_id at creation and left created_by null.
-- No schema change is needed here — this section exists only to record that
-- fact for whoever reads this migration looking for a new column and does
-- not find one: the fix for "originated by" is in application code
-- (createCase), not in the database.
-- ---------------------------------------------------------------------------
