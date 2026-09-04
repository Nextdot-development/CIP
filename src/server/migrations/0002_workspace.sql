-- ===========================================================================
-- 0002 — company-owned workspace data
--
-- Every table here carries company_id as a NOT NULL foreign key. That column
-- is the ownership boundary: it is what the service layer filters on and what
-- migration 0003's row-level security policies check.
--
-- Nothing here stores a formatted string. Dates are timestamptz, money is a
-- minor-unit integer with a currency, percentages are numeric. Colours, icons
-- and relative dates are worked out in the browser.
-- ===========================================================================

create table pod_members (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid        not null references companies(id) on delete cascade,
  full_name  text        not null,
  craft      text        not null,
  bio        text        not null,
  avatar_url text,
  sort_order int         not null default 0,
  created_at timestamptz not null default now()
);

create table requests (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid        not null references companies(id) on delete cascade,
  title        text        not null,
  summary      text        not null,
  status       text        not null check (status in ('completed', 'in_progress', 'in_review', 'blocked', 'scheduled')),
  -- what was asked for, not which icon to draw
  kind         text        not null check (kind in ('image', 'video', 'doc', 'grid')),
  submitted_at timestamptz not null default now(),
  due_at       timestamptz,
  completed_at timestamptz,
  created_at   timestamptz not null default now()
);

create table brand_profiles (
  company_id           uuid primary key references companies(id) on delete cascade,
  understanding_pct    int  not null check (understanding_pct between 0 and 100),
  paid_unlock_pct      int  not null check (paid_unlock_pct between 0 and 100),
  headline             text not null,
  note                 text not null,
  composer_placeholder text not null,
  prompt_suggestions   text[] not null default '{}',
  voice_sounds         text[] not null default '{}',
  voice_never          text[] not null default '{}',
  updated_at           timestamptz not null default now()
);

create table brand_unlocks (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  label      text not null,
  at_pct     int  not null check (at_pct between 0 and 100),
  sort_order int  not null default 0
);

create table brand_topics (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid  not null references companies(id) on delete cascade,
  key        text  not null,
  title      text  not null,
  blurb      text  not null,
  cta        text  not null,
  -- a checklist that is always read and written as one unit
  items      jsonb not null default '[]'::jsonb,
  sort_order int   not null default 0,
  unique (company_id, key)
);

create table brand_confirmations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  question    text not null,
  context     text not null,
  suggestion  text not null,
  answer      text,
  answered_at timestamptz,
  sort_order  int  not null default 0
);

create table brand_palette (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name       text not null,
  hex        text not null,
  sort_order int  not null default 0
);

create table monthly_metrics (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid    not null references companies(id) on delete cascade,
  period     date    not null,
  key        text    not null,
  label      text    not null,
  value      numeric not null,
  unit       text    not null check (unit in ('count', 'percent')),
  note       text,
  delta      numeric,
  delta_unit text check (delta_unit in ('count', 'percent')),
  delta_note text,
  tone       text    not null check (tone in ('brand', 'ok', 'warn', 'stop', 'neutral')),
  sort_order int     not null default 0,
  unique (company_id, period, key)
);

create table work_items (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies(id) on delete cascade,
  title               text not null,
  meta                text not null,
  status              text not null check (status in ('completed', 'in_progress', 'in_review', 'blocked', 'scheduled')),
  -- 'stop' is reserved for work that genuinely cannot ship
  reason_tone         text check (reason_tone in ('stop', 'warn', 'info')),
  reason_text         text,
  fixes               text[] not null default '{}',
  owner_pod_member_id uuid references pod_members(id) on delete set null,
  sort_order          int  not null default 0,
  created_at          timestamptz not null default now()
);

create table rights_items (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid        not null references companies(id) on delete cascade,
  title      text        not null,
  note       text        not null,
  -- days remaining is derived at render time, never stored
  expires_at timestamptz not null,
  sort_order int         not null default 0
);

create table compliance_checks (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name       text not null,
  note       text not null,
  state      text not null check (state in ('pass', 'attention', 'fail')),
  checked_at timestamptz not null default now(),
  sort_order int  not null default 0
);

create table learnings (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  period     date not null,
  text       text not null,
  effect     text not null,
  sort_order int  not null default 0
);

create table cost_lines (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid   not null references companies(id) on delete cascade,
  period       date   not null,
  label        text   not null,
  -- integer minor units (paise), never a formatted string
  amount_minor bigint not null check (amount_minor >= 0),
  currency     text   not null default 'INR',
  sort_order   int    not null default 0
);

create index pod_members_company_idx         on pod_members (company_id);
create index requests_company_idx            on requests (company_id, submitted_at desc);
create index brand_unlocks_company_idx       on brand_unlocks (company_id);
create index brand_topics_company_idx        on brand_topics (company_id);
create index brand_confirmations_company_idx on brand_confirmations (company_id);
create index brand_palette_company_idx       on brand_palette (company_id);
create index monthly_metrics_company_idx     on monthly_metrics (company_id, period);
create index work_items_company_idx          on work_items (company_id);
create index rights_items_company_idx        on rights_items (company_id, expires_at);
create index compliance_checks_company_idx   on compliance_checks (company_id);
create index learnings_company_idx           on learnings (company_id, period);
create index cost_lines_company_idx          on cost_lines (company_id, period);
