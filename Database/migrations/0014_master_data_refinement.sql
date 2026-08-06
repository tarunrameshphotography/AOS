-- ===========================================================================
-- 0014 — Master Data Refinement (Milestone 6, Part 1: geography)
--
-- 0013 seeded Madurai, Chennai and Mumbai as placeholder geography — generic
-- demonstration data, not Amaze's actual footprint. Amaze Loans operates
-- primarily from Coimbatore, and the master data should say so from the
-- start rather than carry unrelated cities "for demonstration" (an explicit
-- instruction for this milestone).
--
-- The demo rows are deactivated, not deleted — the same NEVER_DELETED
-- convention every other reference table in this schema follows, and it
-- costs nothing since nothing yet references them (city/district are not
-- wired into person.city / organisation.city / property.city, per ADR-030).
--
-- No schema change. city.district_id and district.state (free text) already
-- give a three-level hierarchy (city -> district -> state) with no ceiling
-- on how many states it can hold — expanding into Kerala, Karnataka or the
-- rest of India later is purely `insert into district / city`, exactly the
-- property Milestone 6 asked for.
-- ===========================================================================

update district set is_active = false where code in ('madurai', 'chennai', 'mumbai_mmr');
update city     set is_active = false where code in ('madurai', 'chennai', 'mumbai');

insert into district (code, name, state, display_order) values
  ('coimbatore', 'Coimbatore', 'Tamil Nadu', 10),
  ('tiruppur',   'Tiruppur',   'Tamil Nadu', 20),
  ('erode',      'Erode',      'Tamil Nadu', 30)
on conflict (code) do nothing;

-- Amaze's initial operating footprint: Coimbatore city and district, plus the
-- surrounding towns the business actually works cases in. Erode and Tiruppur
-- are separate districts named directly, both already headline cities in
-- their own right. Every other town below sits inside Coimbatore or Tiruppur
-- district. A starting list, not a claim about full district coverage —
-- expand it with more `insert` statements as Amaze's footprint grows, never
-- with a migration.
insert into city (code, name, district_id, display_order)
select v.code, v.name, d.id, v.display_order
from (values
  ('coimbatore',    'Coimbatore',    'coimbatore', 10),
  ('tiruppur',      'Tiruppur',      'tiruppur',   20),
  ('erode',         'Erode',         'erode',      30),
  ('pollachi',      'Pollachi',      'coimbatore', 40),
  ('mettupalayam',  'Mettupalayam',  'coimbatore', 50),
  ('palladam',      'Palladam',      'tiruppur',   60),
  ('udumalpet',     'Udumalpet',     'tiruppur',   70),
  ('kinathukadavu', 'Kinathukadavu', 'coimbatore', 80),
  ('sulur',         'Sulur',         'coimbatore', 90),
  ('annur',         'Annur',         'coimbatore', 100)
) as v(code, name, district_code, display_order)
join district d on d.code = v.district_code
on conflict (code) do nothing;
