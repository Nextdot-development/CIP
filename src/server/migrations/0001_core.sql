-- ===========================================================================
-- 0001 — core identity
--
-- Three ideas, kept separate on purpose:
--   companies   who the workspace belongs to
--   users       who a person is (independent of any company)
--   memberships which companies a person may enter, and as what
--
-- A user is never "in" a company directly. Every access decision in the
-- application resolves through memberships, so adding a second company for
-- one person later is a row, not a migration.
-- ===========================================================================

create extension if not exists pgcrypto;

create table companies (
  id          uuid primary key default gen_random_uuid(),
  slug        text        not null unique,
  name        text        not null,
  legal_name  text,
  industry    text,
  -- Supabase Storage arrives in a later phase; until then this is null and the
  -- client falls back to a drawn monogram.
  logo_url    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Visual identity is genuinely company data in a brand platform, but it is
-- kept out of `companies` so identity queries never drag it along.
create table company_branding (
  company_id       uuid primary key references companies(id) on delete cascade,
  primary_color    text        not null,
  deep_color       text        not null,
  nav_theme        text        not null check (nav_theme in ('light', 'dark')),
  hero_title       text        not null,
  hero_subtitle    text        not null,
  hero_from        text        not null,
  hero_to          text        not null,
  hero_glow        text        not null,
  hero_ink         text        not null,
  updated_at       timestamptz not null default now()
);

create table users (
  id            uuid primary key default gen_random_uuid(),
  -- stored lowercased; the application normalises before every read and write
  email         text        not null unique,
  full_name     text        not null,
  password_hash text        not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_login_at timestamptz
);

create table memberships (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null references users(id) on delete cascade,
  company_id uuid        not null references companies(id) on delete cascade,
  role       text        not null check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  unique (user_id, company_id)
);

create index memberships_user_idx    on memberships (user_id);
create index memberships_company_idx on memberships (company_id);

-- Sessions carry the active company so a multi-company user has one workspace
-- open at a time. The application still re-checks the membership on every
-- request — a session row is a claim, not an authorisation.
create table sessions (
  id           uuid primary key default gen_random_uuid(),
  -- only the SHA-256 of the cookie value is stored; the raw token exists only
  -- in the user's cookie, so a database leak does not hand over live sessions
  token_hash   text        not null unique,
  user_id      uuid        not null references users(id) on delete cascade,
  company_id   uuid        not null references companies(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now(),
  user_agent   text
);

create index sessions_user_idx    on sessions (user_id);
create index sessions_expires_idx on sessions (expires_at);
