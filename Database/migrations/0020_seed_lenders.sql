-- ===========================================================================
-- 0020 — Seed data for the Bank & NBFC Catalogue
--
-- Hand-written, like 0009, 0013 and 0016, and for the same reason (ADR-025):
-- this is DATA. Every row is a starting point maintained by people through
-- the Lender Catalogue screen once the system is live. Adding the next
-- lender is an insert, never a deploy.
--
-- WHAT IS IN HERE, AND WHAT IS DELIBERATELY BLANK
--
-- The brief was explicit: use actual Indian institutions, do not invent
-- banks, and where exact operational details are unknown leave the field
-- blank rather than fabricate it. So:
--
--   Filled in — the institution's name, its legal kind, and its head office
--   city. These are matters of public record and are stable.
--
--   Left blank — branch addresses, branch phone numbers, branch email
--   addresses, IFSC codes, relationship managers, turnaround days, interest
--   rates, product limits, submission portal URLs. Amaze knows these; this
--   migration does not, and a plausible-looking wrong phone number is worse
--   than an empty field because nobody ever checks the one that looks right.
--
--   NO RELATIONSHIP MANAGERS ARE SEEDED. Not one. Inventing the names of
--   bank employees would put fictional people into an operational contact
--   list, and the first person to call one would lose trust in the whole
--   catalogue.
--
--   Branches: one row per active institution, in Coimbatore district, with
--   only the geography filled in. That an SBI or a Bajaj Finance presence
--   exists in Coimbatore is not a guess; which branch on which street is,
--   so the name carries the district and the office replaces it with the
--   real branch. Every other field is null and every row says so in `notes`.
--
-- COVERAGE. Coimbatore and the surrounding districts, per the brief — the
-- lenders Amaze will realistically work with, not an exhaustive index of
-- Indian finance. Kerala-headquartered banks (Federal, South Indian, CSB)
-- are in because they lend actively across the western Tamil Nadu belt;
-- Tamil Nadu's own old private banks (TMB, KVB, City Union) are in because
-- in this market they are often the first call, not an afterthought.
--
-- TWO CORRECTIONS OF RECORD, both deliberate:
--
--   1. Lakshmi Vilas Bank is seeded INACTIVE. It was amalgamated into DBS
--      Bank India on 27 November 2020 and no longer exists as a lender. The
--      brief asked for it as a legacy reference, and inactive-with-a-note is
--      what a legacy reference means in this schema — old cases that name it
--      still resolve, and nobody can pick it for a new one (the never-delete
--      convention, 0014).
--
--   2. There is no separate "HDFC Home Loans" institution. HDFC Ltd merged
--      into HDFC Bank on 1 July 2023; its home loan business is HDFC Bank's
--      home loan business. Creating a second row for it would be exactly the
--      duplicate-identity problem `organisation_alias` exists to prevent
--      (ADR-014), so the former name is recorded as an alias of HDFC Bank
--      and the fact of the merger as a note. IIFL Home Finance and Sundaram
--      Finance are not seeded here: they carry no Coimbatore-first claim
--      this migration can make, and they are added the same way any other
--      lender is — by typing them in.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Part 1 — the four vocabularies.
-- ---------------------------------------------------------------------------

-- RBI's institutional categories. Seven, as the brief required, and the list
-- is a table precisely so that the eighth — a payments bank, a microfinance
-- institution, a fintech lender — is an insert.
insert into lender_type (code, name, description, display_order) values
  ('public_sector_bank',       'Public Sector Bank',        'A commercial bank majority-owned by the Government of India. Broad product range, competitive rates, process-driven and usually slower.', 10),
  ('private_sector_bank',      'Private Sector Bank',       'A privately-owned commercial bank. Faster decisions, wider risk appetite, generally priced above the public sector.', 20),
  ('small_finance_bank',       'Small Finance Bank',        'Licensed to serve small businesses, micro enterprises and the unbanked. Small ticket sizes, local reach, higher rates.', 30),
  ('regional_rural_bank',      'Regional Rural Bank',       'Sponsored by a commercial bank to serve a defined rural region. Priority-sector and agricultural lending.', 40),
  ('cooperative_bank',         'Cooperative Bank',          'A member-owned bank operating under state or multi-state cooperative law. Strong local presence, narrower product range.', 50),
  ('nbfc',                     'NBFC',                      'A non-banking financial company. Lends but takes no demand deposits. Flexible credit assessment, faster turnaround, higher rates.', 60),
  ('housing_finance_company',  'Housing Finance Company',   'An NBFC specialising in housing finance, regulated by the RBI since 2019. Home loans, loans against property, construction finance.', 70)
on conflict (code) do nothing;

-- Roles at a lender, as Amaze deals with them. `bank_contact.designation`
-- keeps whatever the lender's own visiting card says.
insert into lender_relationship_role (code, name, description, display_order) values
  ('relationship_manager', 'Relationship Manager', 'The day-to-day contact for files lodged with this lender. The default.', 10),
  ('branch_manager',       'Branch Manager',       'Heads the branch. Usually the escalation, not the first call.', 20),
  ('credit_manager',       'Credit Manager',       'Assesses the file. Queries and conditions usually originate here.', 30),
  ('sales_manager',        'Sales Manager',        'Sourcing side. Owns targets, and often the one who agrees to look at a borderline case.', 40),
  ('operations_officer',   'Operations Officer',   'Processing and disbursement. Chased for sanction letters and disbursement dates.', 50),
  ('channel_manager',      'Channel Manager',      'Manages the lender''s DSA and connector channel — Amaze''s own relationship sits here at several lenders.', 60)
on conflict (code) do nothing;

-- How a file physically reaches a lender.
insert into submission_mode (code, name, description, display_order) values
  ('branch_counter',   'At the Branch',        'A physical file handed over at the branch. Still the norm at most public sector banks.', 10),
  ('email',            'By Email',             'A scanned set emailed to a credit desk or relationship manager.', 20),
  ('partner_portal',   'Lender Portal',        'Logged through the lender''s own partner or DSA portal.', 30),
  ('connector_app',    'Connector App',        'Logged through the lender''s mobile connector app.', 40),
  ('rm_pickup',        'Collected by the RM',  'The relationship manager collects the file and lodges it internally.', 50)
on conflict (code) do nothing;

-- The categories the lender profile is filed under. These exist so that a
-- note can later be quoted back WITH ITS NATURE ATTACHED — "known
-- limitation" and "process tip" must never read the same to a person or to
-- an assistant.
insert into lender_insight_category (code, name, description, display_order) values
  ('segment_fit',              'Good Fit For',            'Customer segments, trades or profiles this lender handles well. Experience, not a rule.', 10),
  ('strength',                 'Known Strength',          'What this lender is genuinely good at — pricing, speed, flexibility on a particular point.', 20),
  ('limitation',               'Known Limitation',        'Where this lender is difficult, slow or unwilling. Worth knowing before lodging.', 30),
  ('documentation_habit',      'Documentation Habit',     'What this lender routinely asks for beyond the standard set — an extra year of ITR, a specific format of statement.', 40),
  ('process_tip',              'Process Tip',             'How to get a file through faster. Practical, learned the hard way.', 50),
  ('communication_preference', 'Communication Preference','How this lender or its managers prefer to be contacted and followed up.', 60),
  ('rejection_pattern',        'Rejection Pattern',       'What this lender tends to decline. Distinct from the standardised rejection_reason recorded against an actual rejected file (ADR-028).', 70)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Part 2 — the institutions.
--
-- Two statements per institution: an organisation row carrying the 'lender'
-- role (ADR-014 — a lender is not its own entity type), and a lender_profile
-- extension carrying what makes it a lender. Written as one values list
-- joined to lender_type so a new institution is one more line.
--
-- `canonical_name` is the legal or commonly-used name. `code` is the stable
-- internal handle reports and prompts key on.
-- ---------------------------------------------------------------------------

insert into organisation (canonical_name, roles, industry, city, is_active)
select v.name, array['lender']::app.organisation_role[], 'Banking and Finance', v.head_office, v.is_active
from (values
  -- Public sector banks
  ('State Bank of India',                      'Mumbai',     true),
  ('Indian Bank',                              'Chennai',    true),
  ('Canara Bank',                              'Bengaluru',  true),
  ('Bank of Baroda',                           'Vadodara',   true),
  ('Union Bank of India',                      'Mumbai',     true),
  ('Punjab National Bank',                     'New Delhi',  true),
  ('Indian Overseas Bank',                     'Chennai',    true),
  -- Private sector banks
  ('HDFC Bank',                                'Mumbai',     true),
  ('ICICI Bank',                               'Mumbai',     true),
  ('Axis Bank',                                'Mumbai',     true),
  ('Kotak Mahindra Bank',                      'Mumbai',     true),
  ('Federal Bank',                             'Aluva',      true),
  ('South Indian Bank',                        'Thrissur',   true),
  ('CSB Bank',                                 'Thrissur',   true),
  ('Tamilnad Mercantile Bank',                 'Thoothukudi',true),
  ('Karur Vysya Bank',                         'Karur',      true),
  ('City Union Bank',                          'Kumbakonam', true),
  ('Lakshmi Vilas Bank',                       'Chennai',    false),
  -- NBFCs
  ('Bajaj Finance',                            'Pune',       true),
  ('Tata Capital',                             'Mumbai',     true),
  ('Aditya Birla Finance',                     'Mumbai',     true),
  ('Cholamandalam Investment and Finance Company', 'Chennai',true),
  ('Shriram Finance',                          'Chennai',    true),
  ('L&T Finance',                              'Mumbai',     true),
  ('Poonawalla Fincorp',                       'Pune',       true),
  -- Housing finance companies
  ('LIC Housing Finance',                      'Mumbai',     true),
  ('PNB Housing Finance',                      'New Delhi',  true),
  ('Aavas Financiers',                         'Jaipur',     true),
  ('Aptus Value Housing Finance India',        'Chennai',    true)
) as v(name, head_office, is_active)
where not exists (
  select 1 from organisation o
  where o.canonical_name = v.name and 'lender' = any (o.roles)
);

insert into lender_profile (
  organisation_id, lender_type, lender_type_id, code, head_office_city,
  primary_service_region, website_url, is_on_panel, display_order, notes
)
select
  o.id,
  v.legacy_enum::app.lender_type,
  lt.id,
  v.code,
  v.head_office,
  v.region,
  v.website,
  v.on_panel,
  v.display_order,
  v.notes
from (values
  -- code                  canonical name                                   type code                   legacy enum  head office    service region                          website                                on panel  order  notes
  ('sbi',                  'State Bank of India',                           'public_sector_bank',       'bank', 'Mumbai',      'Pan-India',                            'https://sbi.co.in',                   true,  10,  null),
  ('indian_bank',          'Indian Bank',                                   'public_sector_bank',       'bank', 'Chennai',     'Pan-India, strongest in Tamil Nadu',   'https://indianbank.in',               true,  20,  null),
  ('canara_bank',          'Canara Bank',                                   'public_sector_bank',       'bank', 'Bengaluru',   'Pan-India, strongest in South India',  'https://canarabank.com',              true,  30,  null),
  ('bank_of_baroda',       'Bank of Baroda',                                'public_sector_bank',       'bank', 'Vadodara',    'Pan-India',                            'https://bankofbaroda.in',             true,  40,  null),
  ('union_bank',           'Union Bank of India',                           'public_sector_bank',       'bank', 'Mumbai',      'Pan-India',                            'https://unionbankofindia.co.in',      true,  50,  null),
  ('pnb',                  'Punjab National Bank',                          'public_sector_bank',       'bank', 'New Delhi',   'Pan-India, strongest in North India',  'https://pnbindia.in',                 true,  60,  null),
  ('iob',                  'Indian Overseas Bank',                          'public_sector_bank',       'bank', 'Chennai',     'Pan-India, strongest in Tamil Nadu',   'https://iob.in',                      true,  70,  null),

  ('hdfc_bank',            'HDFC Bank',                                     'private_sector_bank',      'bank', 'Mumbai',      'Pan-India',                            'https://hdfcbank.com',                true, 110,
    'HDFC Ltd merged into HDFC Bank with effect from 1 July 2023. What the market still calls "HDFC Home Loans" is this institution — there is deliberately no separate housing finance entity for it in this catalogue.'),
  ('icici_bank',           'ICICI Bank',                                    'private_sector_bank',      'bank', 'Mumbai',      'Pan-India',                            'https://icicibank.com',               true, 120,
    'Registered office is in Vadodara; the corporate office and the lending business are run from Mumbai.'),
  ('axis_bank',            'Axis Bank',                                     'private_sector_bank',      'bank', 'Mumbai',      'Pan-India',                            'https://axisbank.com',                true, 130,
    'Registered office is in Ahmedabad; the corporate office is in Mumbai.'),
  ('kotak_bank',           'Kotak Mahindra Bank',                           'private_sector_bank',      'bank', 'Mumbai',      'Pan-India',                            'https://kotak.com',                   true, 140,  null),
  ('federal_bank',         'Federal Bank',                                  'private_sector_bank',      'bank', 'Aluva',       'Kerala and Tamil Nadu, plus metros',   'https://federalbank.co.in',           true, 150,  null),
  ('south_indian_bank',    'South Indian Bank',                             'private_sector_bank',      'bank', 'Thrissur',    'Kerala and Tamil Nadu',                'https://southindianbank.com',         true, 160,  null),
  ('csb_bank',             'CSB Bank',                                      'private_sector_bank',      'bank', 'Thrissur',    'Kerala and Tamil Nadu',                'https://csb.co.in',                   true, 170,  null),
  ('tmb',                  'Tamilnad Mercantile Bank',                      'private_sector_bank',      'bank', 'Thoothukudi', 'Tamil Nadu',                           'https://tmb.in',                      true, 180,  null),
  ('kvb',                  'Karur Vysya Bank',                              'private_sector_bank',      'bank', 'Karur',       'Tamil Nadu',                           'https://kvb.co.in',                   true, 190,  null),
  ('city_union_bank',      'City Union Bank',                               'private_sector_bank',      'bank', 'Kumbakonam',  'Tamil Nadu',                           'https://cityunionbank.com',           true, 200,  null),
  ('lvb',                  'Lakshmi Vilas Bank',                            'private_sector_bank',      'bank', 'Chennai',     'Tamil Nadu',                           null,                                  false, 210,
    'LEGACY REFERENCE ONLY. Amalgamated into DBS Bank India Ltd on 27 November 2020 and no longer exists as a lender. Kept inactive so that older cases naming it still resolve; it must never be selectable for a new file.'),

  ('bajaj_finance',        'Bajaj Finance',                                 'nbfc',                     'nbfc', 'Pune',        'Pan-India',                            'https://bajajfinserv.in',             true, 310,  null),
  ('tata_capital',         'Tata Capital',                                  'nbfc',                     'nbfc', 'Mumbai',      'Pan-India',                            'https://tatacapital.com',             true, 320,  null),
  ('aditya_birla_finance', 'Aditya Birla Finance',                          'nbfc',                     'nbfc', 'Mumbai',      'Pan-India',                            'https://adityabirlacapital.com',      true, 330,  null),
  ('chola',                'Cholamandalam Investment and Finance Company',  'nbfc',                     'nbfc', 'Chennai',     'Pan-India, strongest in South India',  'https://cholamandalam.com',           true, 340,  null),
  ('shriram_finance',      'Shriram Finance',                               'nbfc',                     'nbfc', 'Chennai',     'Pan-India, strongest in South India',  'https://shriramfinance.in',           true, 350,  null),
  ('lt_finance',           'L&T Finance',                                   'nbfc',                     'nbfc', 'Mumbai',      'Pan-India',                            'https://ltfs.com',                    true, 360,  null),
  ('poonawalla_fincorp',   'Poonawalla Fincorp',                            'nbfc',                     'nbfc', 'Pune',        'Pan-India',                            'https://poonawallafincorp.com',       true, 370,  null),

  ('lic_hfl',              'LIC Housing Finance',                           'housing_finance_company',  'hfc',  'Mumbai',      'Pan-India',                            'https://lichousing.com',              true, 410,  null),
  ('pnb_hfl',              'PNB Housing Finance',                           'housing_finance_company',  'hfc',  'New Delhi',   'Pan-India',                            'https://pnbhousing.com',              true, 420,  null),
  ('aavas',                'Aavas Financiers',                              'housing_finance_company',  'hfc',  'Jaipur',      'Pan-India, semi-urban and rural focus','https://aavas.in',                    true, 430,  null),
  ('aptus',                'Aptus Value Housing Finance India',             'housing_finance_company',  'hfc',  'Chennai',     'South India, semi-urban and rural',    'https://aptusindia.com',              true, 440,  null)
) as v(code, name, type_code, legacy_enum, head_office, region, website, on_panel, display_order, notes)
join organisation o on o.canonical_name = v.name and 'lender' = any (o.roles)
join lender_type lt on lt.code = v.type_code
where not exists (select 1 from lender_profile lp where lp.organisation_id = o.id);

-- The names the market actually uses. Alias rows rather than duplicate
-- organisations — the whole reason lenders are organisations (ADR-014).
insert into organisation_alias (organisation_id, alias, alias_normalised, source)
select o.id, v.alias, lower(v.alias), 'typed_by_user'::app.alias_source
from (values
  ('State Bank of India',                          'SBI'),
  ('Bank of Baroda',                               'BoB'),
  ('Punjab National Bank',                         'PNB'),
  ('Indian Overseas Bank',                         'IOB'),
  ('HDFC Bank',                                    'HDFC'),
  ('HDFC Bank',                                    'HDFC Home Loans'),
  ('HDFC Bank',                                    'HDFC Ltd'),
  ('Karur Vysya Bank',                             'KVB'),
  ('Tamilnad Mercantile Bank',                     'TMB'),
  ('City Union Bank',                              'CUB'),
  ('Lakshmi Vilas Bank',                           'LVB'),
  ('Cholamandalam Investment and Finance Company', 'Chola'),
  ('Cholamandalam Investment and Finance Company', 'Cholamandalam Finance'),
  ('L&T Finance',                                  'LTF'),
  ('LIC Housing Finance',                          'LIC HFL'),
  ('PNB Housing Finance',                          'PNB HFL'),
  ('Aptus Value Housing Finance India',            'Aptus')
) as v(name, alias)
join organisation o on o.canonical_name = v.name and 'lender' = any (o.roles)
where not exists (
  select 1 from organisation_alias a
  where a.organisation_id = o.id and a.alias_normalised = lower(v.alias)
);

-- ---------------------------------------------------------------------------
-- Part 3 — one Coimbatore branch per active institution.
--
-- Geography only. That each of these lenders has a Coimbatore presence is
-- not in doubt; which branch, on which street, with which phone number, is
-- exactly the operational detail this migration is not allowed to guess. So
-- the row exists, it is placed in the right district, and every remaining
-- field is null with a note saying so. The office renames it to the real
-- branch and fills in the rest — one screen, no migration.
-- ---------------------------------------------------------------------------

insert into organisation (canonical_name, roles, industry, city, parent_organisation_id)
select o.canonical_name || ' — Coimbatore', array['branch']::app.organisation_role[],
       'Banking and Finance', 'Coimbatore', o.id
from organisation o
join lender_profile lp on lp.organisation_id = o.id
where o.is_active
  and not exists (
    select 1 from organisation b
    where b.parent_organisation_id = o.id and 'branch' = any (b.roles)
  );

insert into bank_branch (organisation_id, city_id, district_id, operational_status, notes)
select b.id, c.id, d.id, 'operational',
       'Seeded as this lender''s Coimbatore presence, with geography only. '
       'Rename it to the actual branch and fill in the address, phone and '
       'email — the migration that created it deliberately did not guess them.'
from organisation b
join organisation o on o.id = b.parent_organisation_id
join lender_profile lp on lp.organisation_id = o.id
cross join (select id from city where code = 'coimbatore') c
cross join (select id from district where code = 'coimbatore') d
where 'branch' = any (b.roles)
  and b.canonical_name = o.canonical_name || ' — Coimbatore'
  and not exists (select 1 from bank_branch bb where bb.organisation_id = b.id);

-- ---------------------------------------------------------------------------
-- Part 4 — supported products.
--
-- Only what is true by the nature of the institution, which is the only
-- claim this migration can make honestly:
--
--   A housing finance company does home loans and loans against property.
--   That is what the licence is for.
--
--   A universal commercial bank — every public and private sector bank in
--   Part 2 — does home loans, loans against property, business term loans
--   and working capital. That is what a full-service bank is.
--
-- Anything finer (which NBFC does used commercial vehicles, who does gold,
-- who will look at an unsecured business loan above fifty lakh) is real
-- knowledge that varies by year and by branch, and it belongs to the office,
-- entered on the screen. Nothing here carries an amount, a rate or a
-- lender-specific product name, because those are the numbers most worth not
-- inventing.
--
-- `bank_product.name` takes the lending product's own name where the
-- lender's brand name for it is unknown — see that column's comment in 0019.
-- ---------------------------------------------------------------------------

insert into bank_product (organisation_id, loan_product_id, name, is_active, display_order, notes)
select o.id, p.id, p.name, true, p.display_order,
       'Recorded because a full-service commercial bank offers this product. '
       'Replace the name with the lender''s own if it has one, and add limits '
       'and rates as the office learns them.'
from lender_profile lp
join organisation o on o.id = lp.organisation_id and o.is_active
join lender_type lt on lt.id = lp.lender_type_id
join loan_product p on p.code in (
  'hl_purchase', 'hl_self_construct', 'hl_balance_transfer',
  'lap', 'bl_term_loan', 'bl_working_capital'
)
where lt.code in ('public_sector_bank', 'private_sector_bank')
  and not exists (
    select 1 from bank_product bp
    where bp.organisation_id = o.id and bp.loan_product_id = p.id
  );

insert into bank_product (organisation_id, loan_product_id, name, is_active, display_order, notes)
select o.id, p.id, p.name, true, p.display_order,
       'Recorded because a housing finance company offers this product by the '
       'nature of its licence. Add limits and rates as the office learns them.'
from lender_profile lp
join organisation o on o.id = lp.organisation_id and o.is_active
join lender_type lt on lt.id = lp.lender_type_id
join loan_product p on p.code in (
  'hl_purchase', 'hl_self_construct', 'hl_plot_construction',
  'hl_improvement', 'hl_balance_transfer', 'hl_top_up', 'lap'
)
where lt.code = 'housing_finance_company'
  and not exists (
    select 1 from bank_product bp
    where bp.organisation_id = o.id and bp.loan_product_id = p.id
  );

-- ===========================================================================
-- What is NOT seeded, and why — read this before adding it
--
-- Relationship managers. Named people. Never invented.
--
-- Turnaround days, submission modes, portal URLs, login fees. Every one of
-- these is knowledge Amaze has and this migration does not. Seeding a
-- plausible "7 days" would be read as measured fact within a week.
--
-- Lender insights — the lender profile. This is the most valuable table in
-- the milestone and it starts EMPTY on purpose. "Excellent for textile
-- businesses" is only worth storing when it is Amaze's own observation; a
-- seeded one would be an invented opinion attributed to the team, which is
-- worse than an invented phone number because nobody can check it.
--
-- The catalogue is designed so that all of the above is data entry on one
-- screen. None of it needs a migration, and none of it needs a developer.
-- ===========================================================================
