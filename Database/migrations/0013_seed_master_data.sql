-- ===========================================================================
-- 0013 — Seed data for the Milestone 5 master data tables
--
-- Hand-written, like 0009, and for the same reason: this is DATA, maintained
-- by people through master_data.manage once the system is live. Every list
-- below is a starting point, expected to be extended without a deploy — that
-- is the entire reason each one is a table (ADR-025).
-- ===========================================================================

insert into loan_category (code, name, display_order) values
  ('home_loan',     'Home Loan',     10),
  ('business_loan', 'Business Loan', 20),
  ('lap',           'Loan Against Property', 30),
  ('personal_loan', 'Personal Loan', 40)
on conflict (code) do nothing;

insert into employment_type (code, name, description, display_order) values
  ('salaried',       'Salaried',        'Draws a fixed salary from an employer. Payslips and Form 16 are the usual income evidence.', 10),
  ('self_employed',  'Self-Employed',   'Runs a profession or business in their own name. ITR and bank statements substitute for payslips.', 20),
  ('business_owner', 'Business Owner',  'Owns or is a partner in a firm, which may itself be a case party (ADR-009). GST and financials apply.', 30)
on conflict (code) do nothing;

insert into business_constitution (code, name, description, display_order) values
  ('proprietorship',    'Sole Proprietorship', 'One individual owns the business; no separate legal entity.', 10),
  ('partnership',       'Partnership',         'Governed by a partnership deed; two or more partners.', 20),
  ('llp',                'Limited Liability Partnership', 'Registered LLP — partners with limited liability.', 30),
  ('private_limited',   'Private Limited Company', 'Registered under the Companies Act, shares not publicly traded.', 40),
  ('public_limited',    'Public Limited Company', 'Registered under the Companies Act, shares publicly traded.', 50),
  ('huf',                'Hindu Undivided Family', 'A HUF as recognised for tax and lending purposes.', 60),
  ('trust_society',     'Trust / Society', 'A registered trust or society rather than a commercial entity.', 70)
on conflict (code) do nothing;

insert into property_type (code, name, display_order) values
  ('apartment',           'Apartment',            10),
  ('independent_house',   'Independent House',    20),
  ('villa',                'Villa',                30),
  ('plot',                 'Plot',                 40),
  ('commercial',           'Commercial',           50),
  ('agricultural_land',   'Agricultural Land',    60)
on conflict (code) do nothing;

insert into property_ownership_type (code, name, description, display_order) values
  ('freehold',       'Freehold',              'Outright ownership, no lease term.', 10),
  ('leasehold',      'Leasehold',             'Held under a lease for a fixed term.', 20),
  ('ancestral',       'Ancestral',             'Inherited, typically undivided among family members.', 30),
  ('power_of_attorney','Power of Attorney',    'Held or transacted through a registered power of attorney.', 40),
  ('joint_ownership', 'Joint Ownership',       'Title held jointly by two or more named owners.', 50)
on conflict (code) do nothing;

insert into referral_source (code, name, display_order) values
  ('phone_enquiry',    'Phone Enquiry',    10),
  ('walk_in',           'Walk-in',          20),
  ('referral',          'Referral',         30),
  ('repeat_customer',  'Repeat Customer',  40),
  ('builder_tie_up',   'Builder Tie-up',   50),
  ('website',           'Website',          60),
  ('social_media',      'Social Media',     70)
on conflict (code) do nothing;

-- Districts and cities Amaze currently operates in or has cases against, per
-- the seed cases in Frontend/src/fake/seed.ts. A starting footprint, not a
-- claim about where the business will expand.

insert into district (code, name, state, display_order) values
  ('madurai',    'Madurai',    'Tamil Nadu',  10),
  ('chennai',    'Chennai',    'Tamil Nadu',  20),
  ('mumbai_mmr', 'Mumbai',     'Maharashtra', 30)
on conflict (code) do nothing;

insert into city (code, name, district_id, display_order)
select v.code, v.name, d.id, v.display_order
from (values
  ('madurai',  'Madurai',  'madurai',    10),
  ('chennai',  'Chennai',  'chennai',    20),
  ('mumbai',   'Mumbai',   'mumbai_mmr', 30)
) as v(code, name, district_code, display_order)
join district d on d.code = v.district_code
on conflict (code) do nothing;
