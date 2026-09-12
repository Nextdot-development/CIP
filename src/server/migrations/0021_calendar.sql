-- ===========================================================================
-- 0021 — what to make, and when, and for where
--
-- CIP could answer "make something for 8PM in Nigeria" and had no idea that
-- Nigeria's Independence Day is the first of October, or that the brief should
-- have been written three weeks earlier. The calendar lived in a spreadsheet
-- somebody opened in January and nobody opened again.
--
-- An occasion is a small thing to store and the reason it belongs here rather
-- than in a sheet is what CIP can do once it has it: an occasion already knows
-- its market, so a brief started from one draws on that market's knowledge and
-- no other, which is the whole point of having markets at all.
--
-- Three things about the shape.
--
-- The market is the occasion's own, not the company's. A Ghana holiday is not
-- a Nigeria holiday, and a calendar headed "West Africa" that is really Ghana
-- is the mistake this column exists to make visible.
--
-- The brand is nullable and usually null. Christmas is not 8PM's; it is
-- everybody's, and each brand decides what to do with it.
--
-- A date rather than a recurrence rule. Easter moves, Eid moves against the
-- Gregorian calendar every year, and the December selling season is not a day
-- at all. Storing a rule would mean computing dates CIP has no business
-- computing; storing the dates means somebody enters next year's, which is
-- honest work that takes an hour.
-- ===========================================================================

create table content_calendar (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,

  -- What it is. Free text, because an occasion is whatever the market calls it.
  occasion text not null,

  -- Where it applies. Null means everywhere this company sells.
  market text,
  -- Which brand it is for. Null — the common case — means all of them.
  brand  text,

  -- When. A season gets a start and an end; a day has the same date twice.
  starts_on date not null,
  ends_on   date not null,

  kind text not null default 'observance'
    check (kind in ('public_holiday', 'observance', 'season', 'campaign')),

  -- The languages the creative has to exist in. West Africa is bilingual and
  -- forgetting the French half is the most expensive kind of late discovery.
  languages text[] not null default '{}',

  -- Anything a person needs to know that the occasion's name does not say.
  note text,

  -- Where it came from, so an imported row and a typed one are tellable apart
  -- and a re-import does not silently overwrite somebody's own entry.
  source text not null default 'manual'
    check (source in ('manual', 'imported', 'suggested')),

  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),

  check (ends_on >= starts_on)
);

-- One occasion per market per date: the same holiday entered twice is a
-- calendar nobody trusts. A table constraint cannot hold an expression and the
-- market is nullable, where NULL never equals NULL - so the uniqueness goes
-- over a normalised form, exactly as it does for facts and lessons.
create unique index content_calendar_identity_idx
  on content_calendar (company_id, occasion, starts_on, coalesce(market, ''));

create index content_calendar_when_idx on content_calendar (company_id, starts_on);
create index content_calendar_market_idx on content_calendar (company_id, market, starts_on);

alter table content_calendar enable row level security;
alter table content_calendar force  row level security;
create policy cip_company_isolation on content_calendar
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

grant select, insert, update, delete on content_calendar to cip_app;
