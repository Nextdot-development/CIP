-- ===========================================================================
-- 0016 — which brand a fact is about
--
-- Radico Khaitan is one client with nine brands: Magic Moments, 8PM,
-- Whytehall and its flavours, Morpheus, Royal Ranthambore, Blue Finest. Their
-- own brief says it plainly — "do not allow all brands to collapse into the
-- same vocabulary". Whytehall is regal and restrained; Magic Moments is
-- playful and loud. A brief drawn from both at once is neither.
--
-- This is the market problem one level up, with one difference that changes
-- the design. A market could be read off the file: India.pdf is India's. A
-- brand cannot — Radico's context document describes all nine in one file, so
-- knowledge about Whytehall and about Magic Moments arrives in the same
-- upload. The brand therefore belongs to the fact, not the file.
--
-- Attributing it is a judgement, so it is made by the model that is already
-- reading the asset, against a roster this company actually has. A closed list
-- for the same reason task types are closed: free text drifts, and
-- "Whytehall", "Whytehall Whisky" and "WhyteHall" would be three brands by
-- Thursday.
--
-- Null is the common and correct case. "Never target minors" belongs to every
-- brand Radico owns, and a company with no roster at all — most of them — has
-- every fact null and behaves exactly as it did before.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The brands a company works on.
--
-- A roster rather than a free-text column, so the model has something to
-- choose from and a person has something to correct. Ordered by position so a
-- house's own hierarchy survives — the parent's flagship first, not
-- alphabetically.
-- ---------------------------------------------------------------------------
create table company_brands (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,

  name text not null,
  -- One line on what makes it itself. Shown to the model when it attributes a
  -- fact, so "Whytehall" and "Whytehall Honey" can be told apart.
  note text,

  position int not null default 0,

  created_at timestamptz not null default now(),

  unique (id, company_id),
  unique (company_id, name)
);

create index company_brands_lookup_idx on company_brands (company_id, position);

alter table company_brands enable row level security;
alter table company_brands force  row level security;
create policy cip_company_isolation on company_brands
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

grant select, insert, update, delete on company_brands to cip_app;

-- ---------------------------------------------------------------------------
-- Which brand a fact is about. Null means it belongs to the house.
-- ---------------------------------------------------------------------------
alter table brand_dna_facts add column if not exists brand text;

create index if not exists brand_dna_facts_brand_idx
  on brand_dna_facts (company_id, brand) where brand is not null;

-- The identity of a fact now includes its brand: "tone: playful" is a
-- different fact for Magic Moments than for Whytehall, and merging them would
-- give each the other's evidence. Null never equals null, so the uniqueness
-- has to go through a functional index exactly as brain_lessons does.
alter table brand_dna_facts drop constraint if exists brand_dna_facts_company_id_section_attribute_value_key;
drop index if exists brand_dna_facts_identity_idx;
create unique index brand_dna_facts_identity_idx
  on brand_dna_facts (company_id, section, attribute, value, coalesce(brand, ''));
