-- ===========================================================================
-- 0025 — Coimbatore bank, NBFC and branch catalogue
--
-- 0020 seeded the institutions Amaze realistically works with and gave each
-- one a single placeholder branch called "<Bank> — Coimbatore", with the
-- geography filled in and everything else deliberately blank. That was the
-- honest thing to seed at the time: the milestone had no branch-level brief.
--
-- This migration does two things:
--
--   1. Completes the institution list for the Coimbatore market — small
--      finance banks, co-operative banks, and the housing finance companies
--      and NBFCs that actually lend here and were missing.
--   2. Replaces the one placeholder branch per lender with the LOCALITIES
--      each lender is present in.
--
-- ---------------------------------------------------------------------------
-- WHAT IS CLAIMED HERE, AND WHAT IS STILL REFUSED
--
-- 0020 drew a line and this migration keeps it exactly where it was.
--
--   Claimed: that a given lender has a presence in a given Coimbatore
--   locality. For the localities in this file — RS Puram, Gandhipuram, Race
--   Course, Peelamedu, Saibaba Colony, Singanallur, Saravanampatti, Town
--   Hall, Ukkadam, Kuniyamuthur, Thudiyalur — these are the city's actual
--   banking areas, and a branch network of the size these institutions
--   operate covers them. This is a starting list for the office to correct,
--   not a survey.
--
--   STILL REFUSED, and for the same reason as before: street addresses,
--   IFSC codes, branch phone numbers, branch email addresses, and every
--   named human being. Not one relationship manager, not one banker email
--   address is seeded by this migration — and the submission workflow this
--   milestone builds is precisely the thing that would put a fabricated one
--   in front of a user about to send a customer's file to it. A blank field
--   is a prompt. A plausible wrong one is a trap, because nobody checks the
--   value that looks right.
--
-- BRANCH NAMES carry their locality — "Indian Bank — RS Puram" — because
-- that is what the office calls them, and because the branch is the
-- counterparty a file physically goes to (ADR-015). Every one stays editable
-- master data: rename it, move it, close it, add the ones this file missed.
--
-- COIMBATORE ONLY, as the brief required. Tiruppur and Erode districts exist
-- in the geography (0014) and get their own seed when the business asks for
-- one. Nothing here is structural — covering another district is more insert
-- statements, which was the property 0012 and 0014 were designed to have.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Part 1 — the institutions 0020 did not have
--
-- Small finance banks and co-operative banks were both named in this
-- milestone's brief and both were genuinely absent. Neither is a rounding
-- error in this market: an SFB is often the only lender that will look at a
-- small trader with two years of patchy banking, and the district central
-- co-operative bank is a real counterparty for agricultural and small
-- business files in the Coimbatore belt.
--
-- The NBFCs and HFCs added here are the ones whose absence was conspicuous
-- for THIS city — gold loan NBFCs, which in Coimbatore are a mainstream
-- short-term funding route rather than a fringe one, and the Tamil Nadu
-- housing financiers (Repco, Sundaram Home, Can Fin) that compete directly
-- for the self-construction and plot-purchase files Amaze arranges.
-- ---------------------------------------------------------------------------

insert into organisation (canonical_name, roles, industry, city, is_active)
select v.name, array['lender']::app.organisation_role[], 'Banking and Finance', v.head_office, true
from (values
  -- Public sector banks with a real Coimbatore network, missing from 0020
  ('Bank of India',                             'Mumbai'),
  ('Central Bank of India',                     'Mumbai'),
  -- Private sector
  ('IndusInd Bank',                             'Mumbai'),
  ('IDFC FIRST Bank',                           'Mumbai'),
  ('Karnataka Bank',                            'Mangaluru'),
  -- Small finance banks
  ('Equitas Small Finance Bank',                'Chennai'),
  ('Ujjivan Small Finance Bank',                'Bengaluru'),
  ('ESAF Small Finance Bank',                   'Thrissur'),
  ('AU Small Finance Bank',                     'Jaipur'),
  ('Jana Small Finance Bank',                   'Bengaluru'),
  -- Co-operative banks
  ('Coimbatore District Central Co-operative Bank', 'Coimbatore'),
  ('Coimbatore City Co-operative Bank',         'Coimbatore'),
  -- NBFCs
  ('Muthoot Finance',                           'Kochi'),
  ('Manappuram Finance',                        'Thrissur'),
  ('Hinduja Leyland Finance',                   'Chennai'),
  -- Housing finance companies
  ('Repco Home Finance',                        'Chennai'),
  ('Can Fin Homes',                             'Bengaluru'),
  ('Sundaram Home Finance',                     'Chennai'),
  ('Home First Finance Company India',          'Mumbai'),
  ('India Shelter Finance Corporation',         'Gurugram'),
  ('Bajaj Housing Finance',                     'Pune')
) as v(name, head_office)
where not exists (
  select 1 from organisation o where o.canonical_name = v.name
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
  true,
  v.display_order,
  v.notes
from (values
  -- name, code, type code, legacy enum, head office, region, website, order, notes
  ('Bank of India',                            'bank_of_india',   'public_sector_bank',      'bank', 'Mumbai',     'Pan-India',                                'https://bankofindia.co.in',    75,  null),
  ('Central Bank of India',                    'central_bank',    'public_sector_bank',      'bank', 'Mumbai',     'Pan-India',                                'https://centralbankofindia.co.in', 76, null),
  ('IndusInd Bank',                            'indusind_bank',   'private_sector_bank',     'bank', 'Mumbai',     'Pan-India',                                'https://indusind.com',         165, null),
  ('IDFC FIRST Bank',                          'idfc_first',      'private_sector_bank',     'bank', 'Mumbai',     'Pan-India',                                'https://idfcfirstbank.com',    166, null),
  ('Karnataka Bank',                           'karnataka_bank',  'private_sector_bank',     'bank', 'Mangaluru',  'Karnataka and Tamil Nadu',                 'https://karnatakabank.com',    167, null),
  ('Equitas Small Finance Bank',               'equitas_sfb',     'small_finance_bank',      'bank', 'Chennai',    'Tamil Nadu and South India',               'https://equitasbank.com',      210,
     'Converted from Equitas Micro Finance. Strong in small-ticket business and used commercial vehicle lending across western Tamil Nadu.'),
  ('Ujjivan Small Finance Bank',               'ujjivan_sfb',     'small_finance_bank',      'bank', 'Bengaluru',  'Pan-India, South India focus',             'https://ujjivansfb.in',        220, null),
  ('ESAF Small Finance Bank',                  'esaf_sfb',        'small_finance_bank',      'bank', 'Thrissur',   'Kerala and Tamil Nadu',                    'https://esafbank.com',         230, null),
  ('AU Small Finance Bank',                    'au_sfb',          'small_finance_bank',      'bank', 'Jaipur',     'Pan-India',                                'https://aubank.in',            240, null),
  ('Jana Small Finance Bank',                  'jana_sfb',        'small_finance_bank',      'bank', 'Bengaluru',  'Pan-India, South India focus',             'https://janabank.com',         250, null),
  ('Coimbatore District Central Co-operative Bank', 'cdcc_bank',  'cooperative_bank',        'bank', 'Coimbatore', 'Coimbatore district',                      null,                           260,
     'The district central co-operative bank for Coimbatore. Agricultural, jewel and small business lending, and for many rural files in the district the first counterparty rather than an afterthought.'),
  ('Coimbatore City Co-operative Bank',        'cccb',            'cooperative_bank',        'bank', 'Coimbatore', 'Coimbatore city',                          null,                           270, null),
  ('Muthoot Finance',                          'muthoot_finance', 'nbfc',                    'nbfc', 'Kochi',      'Pan-India',                                'https://muthootfinance.com',   330,
     'Predominantly gold loans. In this market that is a mainstream short-term funding route, not a fringe one — which is why it is catalogued rather than left out.'),
  ('Manappuram Finance',                       'manappuram',      'nbfc',                    'nbfc', 'Thrissur',   'Pan-India, South India focus',             'https://manappuram.com',       340, null),
  ('Hinduja Leyland Finance',                  'hinduja_leyland', 'nbfc',                    'nbfc', 'Chennai',    'Pan-India, South India focus',             'https://hindujaleylandfinance.com', 350,
     'Commercial vehicle and construction equipment finance. Relevant here because Coimbatore''s transport and engineering trade is a recurring source of files.'),
  ('Repco Home Finance',                       'repco',           'housing_finance_company', 'hfc',  'Chennai',    'Tamil Nadu and South India',               'https://repcohome.com',        415,
     'Tamil Nadu focused, and long-established with self-employed and semi-formal-income borrowers — the profile most often turned away by a bank.'),
  ('Can Fin Homes',                            'can_fin',         'housing_finance_company', 'hfc',  'Bengaluru',  'South India',                              'https://canfinhomes.com',      420, null),
  ('Sundaram Home Finance',                    'sundaram_home',   'housing_finance_company', 'hfc',  'Chennai',    'South India',                              'https://sundaramhome.in',      425,
     'The housing arm of the Sundaram Finance group. A separate regulated entity from Sundaram Finance, which is already catalogued — two institutions, not one with two names.'),
  ('Home First Finance Company India',         'home_first',      'housing_finance_company', 'hfc',  'Mumbai',     'Pan-India, affordable housing',            'https://homefirstindia.com',   430, null),
  ('India Shelter Finance Corporation',        'india_shelter',   'housing_finance_company', 'hfc',  'Gurugram',   'Pan-India, affordable housing',            'https://indiashelter.in',      435, null),
  ('Bajaj Housing Finance',                    'bajaj_housing',   'housing_finance_company', 'hfc',  'Pune',       'Pan-India',                                'https://bajajhousingfinance.in', 440,
     'A separate housing finance company within the Bajaj group. Bajaj Finance, already catalogued, is the NBFC — they are different lenders with different files.')
) as v(name, code, type_code, legacy_enum, head_office, region, website, display_order, notes)
join organisation o on o.canonical_name = v.name
join lender_type lt on lt.code = v.type_code
where not exists (
  select 1 from lender_profile lp where lp.organisation_id = o.id
);

insert into organisation_alias (organisation_id, alias, alias_normalised, source)
select o.id, v.alias, lower(v.alias), 'typed_by_user'::app.alias_source
from (values
  ('Bank of India',                                 'BOI'),
  ('Central Bank of India',                         'CBI'),
  ('IDFC FIRST Bank',                               'IDFC'),
  ('Equitas Small Finance Bank',                    'Equitas'),
  ('Ujjivan Small Finance Bank',                    'Ujjivan'),
  ('ESAF Small Finance Bank',                       'ESAF'),
  ('AU Small Finance Bank',                         'AU Bank'),
  ('Jana Small Finance Bank',                       'Jana Bank'),
  ('Coimbatore District Central Co-operative Bank', 'CDCC Bank'),
  ('Coimbatore District Central Co-operative Bank', 'Coimbatore Central Co-operative Bank'),
  ('Muthoot Finance',                               'Muthoot'),
  ('Manappuram Finance',                            'Manappuram'),
  ('Hinduja Leyland Finance',                       'HLF'),
  ('Repco Home Finance',                            'Repco'),
  ('Can Fin Homes',                                 'CanFin'),
  ('Home First Finance Company India',              'Home First'),
  ('India Shelter Finance Corporation',             'India Shelter'),
  ('Bajaj Housing Finance',                         'Bajaj HFL')
) as v(name, alias)
join organisation o on o.canonical_name = v.name
where not exists (
  select 1 from organisation_alias a
  where a.organisation_id = o.id and a.alias_normalised = lower(v.alias)
);

-- Supported products, on the same principle 0020 used and no further: what is
-- true by the nature of the licence, never a claim about a particular
-- lender's appetite. A universal bank does home loans, LAP and business
-- lending; a housing finance company does housing and LAP; an NBFC's book
-- varies far too much to assert anything, so nothing is asserted.
insert into bank_product (organisation_id, loan_product_id, name, is_active, display_order, notes)
select lp_org.organisation_id, prod.id, prod.name, true, prod.display_order,
       'Recorded because an institution of this kind offers this product. '
       'Replace the name with the lender''s own if it has one, and add limits '
       'and rates as the office learns them.'
from lender_profile lp_org
join lender_type lt on lt.id = lp_org.lender_type_id
join loan_product prod
  on prod.code = any (
       case
         when lt.code in ('public_sector_bank', 'private_sector_bank', 'small_finance_bank', 'cooperative_bank')
           then array['hl_purchase', 'hl_self_construct', 'hl_balance_transfer', 'lap', 'bl_term_loan', 'bl_working_capital']
         when lt.code = 'housing_finance_company'
           then array['hl_purchase', 'hl_self_construct', 'hl_plot_construction', 'hl_improvement', 'hl_balance_transfer', 'hl_top_up', 'lap']
         else array[]::text[]
       end
     )
where lp_org.code in (
  'bank_of_india', 'central_bank', 'indusind_bank', 'idfc_first', 'karnataka_bank',
  'equitas_sfb', 'ujjivan_sfb', 'esaf_sfb', 'au_sfb', 'jana_sfb',
  'cdcc_bank', 'cccb',
  'repco', 'can_fin', 'sundaram_home', 'home_first', 'india_shelter', 'bajaj_housing'
)
and not exists (
  select 1 from bank_product bp
  where bp.organisation_id = lp_org.organisation_id and bp.loan_product_id = prod.id
);

-- ---------------------------------------------------------------------------
-- Part 2 — branches, by locality
--
-- The placeholder "<Bank> — Coimbatore" branch 0020 created is RENAMED to the
-- lender's first locality rather than deleted, so that anything already
-- pointing at it — a submission, a bank contact — keeps pointing at a branch
-- that still exists. Never delete; that convention has held since 0014 and it
-- holds here.
-- ---------------------------------------------------------------------------

create temporary table coimbatore_branch (
  lender_code   text not null,
  locality      text not null,
  display_order integer not null
) on commit drop;

insert into coimbatore_branch (lender_code, locality, display_order)
select v.lender_code, v.locality, (row_number() over (partition by v.lender_code order by v.ord))::int * 10
from (values
  -- Public sector banks. Large networks; these are the localities a file is
  -- realistically lodged at, not the whole branch list.
  ('sbi',              'RS Puram',        1), ('sbi',              'Gandhipuram',     2),
  ('sbi',              'Race Course',     3), ('sbi',              'Peelamedu',       4),
  ('sbi',              'Saibaba Colony',  5), ('sbi',              'Singanallur',     6),
  ('sbi',              'Town Hall',       7),
  ('indian_bank',      'RS Puram',        1), ('indian_bank',      'Gandhipuram',     2),
  ('indian_bank',      'Town Hall',       3), ('indian_bank',      'Peelamedu',       4),
  ('indian_bank',      'Saibaba Colony',  5), ('indian_bank',      'Ukkadam',         6),
  ('indian_bank',      'Saravanampatti',  7),
  ('canara_bank',      'RS Puram',        1), ('canara_bank',      'Gandhipuram',     2),
  ('canara_bank',      'Peelamedu',       3), ('canara_bank',      'Saibaba Colony',  4),
  ('canara_bank',      'Singanallur',     5), ('canara_bank',      'Thudiyalur',      6),
  ('bank_of_baroda',   'RS Puram',        1), ('bank_of_baroda',   'Gandhipuram',     2),
  ('bank_of_baroda',   'Peelamedu',       3), ('bank_of_baroda',   'Singanallur',     4),
  ('union_bank',       'RS Puram',        1), ('union_bank',       'Gandhipuram',     2),
  ('union_bank',       'Town Hall',       3), ('union_bank',       'Peelamedu',       4),
  ('pnb',              'Gandhipuram',     1), ('pnb',              'RS Puram',        2),
  ('pnb',              'Peelamedu',       3),
  ('iob',              'RS Puram',        1), ('iob',              'Gandhipuram',     2),
  ('iob',              'Town Hall',       3), ('iob',              'Ukkadam',         4),
  ('iob',              'Peelamedu',       5), ('iob',              'Saibaba Colony',  6),
  ('bank_of_india',    'Gandhipuram',     1), ('bank_of_india',    'RS Puram',        2),
  ('bank_of_india',    'Peelamedu',       3),
  ('central_bank',     'Gandhipuram',     1), ('central_bank',     'RS Puram',        2),

  -- Private sector banks. Concentrated in the commercial and IT belts —
  -- Race Course for corporate, Peelamedu and Saravanampatti for the
  -- Avinashi Road corridor.
  ('hdfc_bank',        'RS Puram',        1), ('hdfc_bank',        'Race Course',     2),
  ('hdfc_bank',        'Peelamedu',       3), ('hdfc_bank',        'Saravanampatti',  4),
  ('hdfc_bank',        'Gandhipuram',     5), ('hdfc_bank',        'Saibaba Colony',  6),
  ('icici_bank',       'RS Puram',        1), ('icici_bank',       'Race Course',     2),
  ('icici_bank',       'Peelamedu',       3), ('icici_bank',       'Saravanampatti',  4),
  ('icici_bank',       'Gandhipuram',     5),
  ('axis_bank',        'RS Puram',        1), ('axis_bank',        'Race Course',     2),
  ('axis_bank',        'Peelamedu',       3), ('axis_bank',        'Saravanampatti',  4),
  ('kotak_bank',       'RS Puram',        1), ('kotak_bank',       'Race Course',     2),
  ('kotak_bank',       'Peelamedu',       3),
  ('indusind_bank',    'RS Puram',        1), ('indusind_bank',    'Race Course',     2),
  ('indusind_bank',    'Peelamedu',       3),
  ('idfc_first',       'RS Puram',        1), ('idfc_first',       'Race Course',     2),
  ('federal_bank',     'RS Puram',        1), ('federal_bank',     'Gandhipuram',     2),
  ('federal_bank',     'Peelamedu',       3), ('federal_bank',     'Saibaba Colony',  4),
  ('south_indian_bank','RS Puram',        1), ('south_indian_bank','Gandhipuram',     2),
  ('south_indian_bank','Peelamedu',       3),
  ('csb_bank',         'RS Puram',        1), ('csb_bank',         'Gandhipuram',     2),
  ('csb_bank',         'Town Hall',       3),
  ('tmb',              'RS Puram',        1), ('tmb',              'Gandhipuram',     2),
  ('tmb',              'Town Hall',       3), ('tmb',              'Ukkadam',         4),
  ('tmb',              'Peelamedu',       5),
  ('kvb',              'RS Puram',        1), ('kvb',              'Gandhipuram',     2),
  ('kvb',              'Town Hall',       3), ('kvb',              'Peelamedu',       4),
  ('kvb',              'Saibaba Colony',  5),
  ('city_union_bank',  'RS Puram',        1), ('city_union_bank',  'Gandhipuram',     2),
  ('city_union_bank',  'Town Hall',       3), ('city_union_bank',  'Ukkadam',         4),
  ('karnataka_bank',   'RS Puram',        1), ('karnataka_bank',   'Gandhipuram',     2),

  -- Small finance banks. Weighted towards the trading and industrial areas —
  -- Ukkadam, Town Hall, Singanallur — which is where their borrowers are.
  ('equitas_sfb',      'Gandhipuram',     1), ('equitas_sfb',      'RS Puram',        2),
  ('equitas_sfb',      'Ukkadam',         3), ('equitas_sfb',      'Singanallur',     4),
  ('equitas_sfb',      'Peelamedu',       5),
  ('ujjivan_sfb',      'Gandhipuram',     1), ('ujjivan_sfb',      'Ukkadam',         2),
  ('ujjivan_sfb',      'Singanallur',     3),
  ('esaf_sfb',         'Gandhipuram',     1), ('esaf_sfb',         'Ukkadam',         2),
  ('au_sfb',           'RS Puram',        1), ('au_sfb',           'Peelamedu',       2),
  ('au_sfb',           'Gandhipuram',     3),
  ('jana_sfb',         'Gandhipuram',     1), ('jana_sfb',         'Ukkadam',         2),

  -- Co-operative banks. Old city and market areas.
  ('cdcc_bank',        'Town Hall',       1), ('cdcc_bank',        'Gandhipuram',     2),
  ('cdcc_bank',        'Ukkadam',         3),
  ('cccb',             'Town Hall',       1), ('cccb',             'Ukkadam',         2),

  -- NBFCs. Race Course for the corporate offices; the gold loan lenders
  -- spread wide across residential and market localities because that is
  -- what a gold loan branch network is.
  ('bajaj_finance',    'Race Course',     1), ('bajaj_finance',    'Peelamedu',       2),
  ('bajaj_finance',    'Gandhipuram',     3),
  ('tata_capital',     'Race Course',     1), ('tata_capital',     'Peelamedu',       2),
  ('aditya_birla_finance', 'Race Course', 1), ('aditya_birla_finance', 'Peelamedu',   2),
  ('chola',            'Race Course',     1), ('chola',            'Gandhipuram',     2),
  ('chola',            'Singanallur',     3),
  ('shriram_finance',  'Gandhipuram',     1), ('shriram_finance',  'Singanallur',     2),
  ('shriram_finance',  'Ukkadam',         3), ('shriram_finance',  'Peelamedu',       4),
  ('sundaram_finance', 'Race Course',     1), ('sundaram_finance', 'Gandhipuram',     2),
  ('sundaram_finance', 'Peelamedu',       3),
  ('lt_finance',       'Race Course',     1), ('lt_finance',       'Peelamedu',       2),
  ('poonawalla_fincorp', 'Race Course',   1),
  ('muthoot_finance',  'Gandhipuram',     1), ('muthoot_finance',  'Town Hall',       2),
  ('muthoot_finance',  'Ukkadam',         3), ('muthoot_finance',  'RS Puram',        4),
  ('muthoot_finance',  'Saibaba Colony',  5), ('muthoot_finance',  'Singanallur',     6),
  ('muthoot_finance',  'Thudiyalur',      7),
  ('manappuram',       'Gandhipuram',     1), ('manappuram',       'Town Hall',       2),
  ('manappuram',       'Ukkadam',         3), ('manappuram',       'RS Puram',        4),
  ('manappuram',       'Singanallur',     5),
  ('hinduja_leyland',  'Race Course',     1), ('hinduja_leyland',  'Singanallur',     2),

  -- Housing finance companies. The affordable-housing lenders sit in the
  -- growth localities — Kuniyamuthur, Thudiyalur, Saravanampatti — which is
  -- where the self-construction and plot-purchase files come from.
  ('lic_hfl',          'Race Course',     1), ('lic_hfl',          'RS Puram',        2),
  ('lic_hfl',          'Peelamedu',       3),
  ('pnb_hfl',          'Race Course',     1), ('pnb_hfl',          'Peelamedu',       2),
  ('iifl_home_finance','Gandhipuram',     1), ('iifl_home_finance','Peelamedu',       2),
  ('aavas',            'Gandhipuram',     1), ('aavas',            'Thudiyalur',      2),
  ('aavas',            'Kuniyamuthur',    3),
  ('aptus',            'Gandhipuram',     1), ('aptus',            'Kuniyamuthur',    2),
  ('aptus',            'Thudiyalur',      3), ('aptus',            'Singanallur',     4),
  ('repco',            'RS Puram',        1), ('repco',            'Gandhipuram',     2),
  ('repco',            'Peelamedu',       3), ('repco',            'Kuniyamuthur',    4),
  ('can_fin',          'RS Puram',        1), ('can_fin',          'Peelamedu',       2),
  ('can_fin',          'Saravanampatti',  3),
  ('sundaram_home',    'Race Course',     1), ('sundaram_home',    'RS Puram',        2),
  ('sundaram_home',    'Peelamedu',       3),
  ('home_first',       'Gandhipuram',     1), ('home_first',       'Kuniyamuthur',    2),
  ('home_first',       'Saravanampatti',  3),
  ('india_shelter',    'Gandhipuram',     1), ('india_shelter',    'Thudiyalur',      2),
  ('bajaj_housing',    'Race Course',     1), ('bajaj_housing',    'Peelamedu',       2)
) as v(lender_code, locality, ord);

-- 2a — rename each lender's placeholder branch to its first locality.
update organisation b
   set canonical_name = o.canonical_name || ' — ' || first_locality.locality
  from organisation o
       join lender_profile lp on lp.organisation_id = o.id
       join lateral (
         select cb.locality
           from coimbatore_branch cb
          where cb.lender_code = lp.code
          order by cb.display_order
          limit 1
       ) first_locality on true
 where b.parent_organisation_id = o.id
   and 'branch' = any (b.roles)
   and b.canonical_name = o.canonical_name || ' — Coimbatore';

update bank_branch bb
   set notes = 'Locality recorded from the Coimbatore catalogue (0025). The '
               'street address, phone, email and IFSC are deliberately not '
               'seeded — fill them in from the branch you actually deal with.'
  from organisation b
       join organisation o on o.id = b.parent_organisation_id
       join lender_profile lp on lp.organisation_id = o.id
 where bb.organisation_id = b.id
   and exists (select 1 from coimbatore_branch cb where cb.lender_code = lp.code);

-- 2b — the remaining localities.
insert into organisation (canonical_name, roles, industry, city, parent_organisation_id)
select o.canonical_name || ' — ' || cb.locality,
       array['branch']::app.organisation_role[],
       'Banking and Finance', 'Coimbatore', o.id
from coimbatore_branch cb
join lender_profile lp on lp.code = cb.lender_code
join organisation o on o.id = lp.organisation_id
where o.is_active
  and not exists (
    select 1 from organisation b
    where b.parent_organisation_id = o.id
      and b.canonical_name = o.canonical_name || ' — ' || cb.locality
  );

insert into bank_branch (organisation_id, city_id, district_id, operational_status, display_order, notes)
select b.id, c.id, d.id, 'operational', cb.display_order,
       'Locality recorded from the Coimbatore catalogue (0025). The street '
       'address, phone, email and IFSC are deliberately not seeded — fill '
       'them in from the branch you actually deal with.'
from coimbatore_branch cb
join lender_profile lp on lp.code = cb.lender_code
join organisation o on o.id = lp.organisation_id
join organisation b
  on b.parent_organisation_id = o.id
 and b.canonical_name = o.canonical_name || ' — ' || cb.locality
cross join (select id from city where code = 'coimbatore') c
cross join (select id from district where code = 'coimbatore') d
where not exists (select 1 from bank_branch bb where bb.organisation_id = b.id);

-- ---------------------------------------------------------------------------
-- What was NOT seeded, restated because this is the milestone where it
-- matters most.
--
-- `bank_contact` gains not one row here. The submission workflow this
-- milestone builds asks a user to pick bankers to address a file to, and a
-- seeded name or address would be offered to them at exactly that moment,
-- against a real customer's file. Every banker email in this system will have
-- been typed in by somebody at Amaze who has that person's card.
--
-- `submission_recipient` gains not one row either: it belongs to case
-- history, and there is no case history to invent.
-- ---------------------------------------------------------------------------
