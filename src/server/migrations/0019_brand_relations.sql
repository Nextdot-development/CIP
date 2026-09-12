-- ===========================================================================
-- 0019 — how a company's brands relate to each other
--
-- A house of fifteen brands is not fifteen unrelated things. Whytehall Honey
-- and Magic Moments Remix are both flavoured; Rampur and Jaisalmer both sell
-- into the same markets; 8PM and Morpheus sit at the same price. Somebody who
-- knows the portfolio knows this, and CIP did not: every brand was an island,
-- so nothing could be said about one by looking at its neighbours.
--
-- Two tables, and neither of them holds an opinion.
--
-- A trait is something a brand demonstrably is, taken from what CIP already
-- learnt rather than from a list somebody maintains. The kinds are the
-- attribute names the Brain itself chose while reading the assets — flavour,
-- productType, liquid colour, typographic style — plus the markets the files
-- came from. Nothing here knows what a flavour is; it knows that two brands
-- were both described with the same one.
--
-- A relation is a pair of brands and how much they share, with the shared
-- traits kept alongside the number so it can always be explained. Weighted by
-- how rare a trait is across the roster: "flavour: honey" held by two brands
-- says a great deal, "background: black" held by all fifteen says nothing.
--
-- Both are derived, so both are safe to delete and recompute. Neither is ever
-- used as a fact about a brand: a relation says Rampur and Jaisalmer are
-- alike, never that Rampur is what Jaisalmer looks like. Borrowing a
-- neighbour's look is the exact failure the roster exists to prevent.
-- ===========================================================================

create table brand_traits (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,

  brand text not null,
  -- What kind of thing this is: an attribute the Brain named while reading an
  -- asset, or 'market' for where the files came from. Open rather than a
  -- closed list, because the vocabulary is the company's own and a fixed one
  -- would stop at whatever CIP could describe on the day it was written.
  kind  text not null,
  -- Normalised for comparison: lower case, collapsed whitespace. The readable
  -- form lives on the facts this was derived from.
  value text not null,

  -- How many of this brand's facts said it. Confidence in the trait, not in
  -- the relation.
  evidence_count int not null default 1 check (evidence_count > 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  unique (company_id, brand, kind, value)
);

create index brand_traits_lookup_idx on brand_traits (company_id, kind, value);
create index brand_traits_brand_idx  on brand_traits (company_id, brand);

create table brand_relations (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,

  -- Stored once per pair, ordered so that a pair cannot appear twice with its
  -- ends swapped. Readers ask for either end.
  brand_a text not null,
  brand_b text not null,

  -- 0 to 1. How much of what is known about each brand is the same thing,
  -- weighted so that a trait everybody shares counts for almost nothing.
  score numeric(5, 4) not null check (score >= 0 and score <= 1),

  -- The traits behind the number, strongest first. Kept so the answer to "why
  -- are these two related?" is a list of shared facts rather than a score.
  shared jsonb not null default '[]'::jsonb,

  updated_at timestamptz not null default now(),

  unique (id, company_id),
  unique (company_id, brand_a, brand_b),
  check (brand_a < brand_b)
);

create index brand_relations_a_idx on brand_relations (company_id, brand_a, score desc);
create index brand_relations_b_idx on brand_relations (company_id, brand_b, score desc);

alter table brand_traits    enable row level security;
alter table brand_relations enable row level security;
alter table brand_traits    force row level security;
alter table brand_relations force row level security;

create policy brand_traits_isolation on brand_traits
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

create policy brand_relations_isolation on brand_relations
  using (company_id = cip_current_company())
  with check (company_id = cip_current_company());

grant select, insert, update, delete on brand_traits    to cip_app;
grant select, insert, update, delete on brand_relations to cip_app;
