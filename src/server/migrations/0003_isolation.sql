-- ===========================================================================
-- 0003 — the isolation boundary
--
-- Two layers guard company data, and they fail independently:
--
--   1. The service layer. Company-owned data is only reachable through a
--      CompanyScope built from the session, and every query filters on it.
--      This is the layer the isolation test exercises.
--
--   2. This migration. Row-level security on every company-owned table, keyed
--      to a per-transaction setting the request pipeline sets from the session.
--      If a future query forgets its WHERE clause, the database returns
--      nothing rather than another company's rows.
--
-- IMPORTANT: PostgreSQL lets superusers and BYPASSRLS roles read straight
-- through row-level security. Layer 2 therefore only binds when the
-- application connects as `cip_app` (created below), never as `postgres`.
-- GET /api/health reports whether it is actually binding.
-- ===========================================================================

-- Reads the company for the current transaction. Returns null when nothing has
-- been set, which makes every policy below fail closed.
create or replace function cip_current_company() returns uuid
  language sql
  stable
as $$
  select nullif(current_setting('cip.company_id', true), '')::uuid
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cip_app') then
    -- No password here: the migration runner sets it from CIP_APP_DB_PASSWORD
    -- so a secret never lands in a committed .sql file. If you are running
    -- this by hand in the Supabase SQL editor, set it yourself afterwards:
    --   alter role cip_app with password '...';
    create role cip_app login nosuperuser nobypassrls nocreatedb nocreaterole noinherit;
  end if;
end
$$;

grant usage on schema public to cip_app;
grant select, insert, update, delete on all tables in schema public to cip_app;
grant execute on function cip_current_company() to cip_app;
alter default privileges in schema public
  grant select, insert, update, delete on tables to cip_app;

-- --------------------------------------------------------------------------
-- Company-owned tables. `force` makes the policy apply to the table owner too,
-- so ownership alone is not a way around it.
-- --------------------------------------------------------------------------
do $$
declare
  t text;
  company_tables text[] := array[
    'company_branding', 'pod_members', 'requests', 'brand_profiles',
    'brand_unlocks', 'brand_topics', 'brand_confirmations', 'brand_palette',
    'monthly_metrics', 'work_items', 'rights_items', 'compliance_checks',
    'learnings', 'cost_lines'
  ];
begin
  foreach t in array company_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy cip_company_isolation on %I
         using (company_id = cip_current_company())
         with check (company_id = cip_current_company())', t);
  end loop;
end
$$;

-- `companies` is keyed on its own id rather than a company_id column.
alter table companies enable row level security;
alter table companies force row level security;
create policy cip_company_isolation on companies
  using (id = cip_current_company())
  with check (id = cip_current_company());

-- --------------------------------------------------------------------------
-- Authentication tables are deliberately NOT under company policies: sign-in
-- has to read a user and their memberships before any company is known. They
-- are reachable only from src/server/auth, and never returned to a client.
-- --------------------------------------------------------------------------
