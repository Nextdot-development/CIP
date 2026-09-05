-- Undo 0003 — removes the second isolation layer.
--
-- The application connects as cip_app, so stop it before running this or the
-- DROP ROLE will fail with "role cannot be dropped because some objects
-- depend on it".

do $$
declare
  t text;
  guarded text[] := array[
    'companies', 'company_branding', 'pod_members', 'requests', 'brand_profiles',
    'brand_unlocks', 'brand_topics', 'brand_confirmations', 'brand_palette',
    'monthly_metrics', 'work_items', 'rights_items', 'compliance_checks',
    'learnings', 'cost_lines'
  ];
begin
  foreach t in array guarded loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('drop policy if exists cip_company_isolation on %I', t);
      execute format('alter table %I no force row level security', t);
      execute format('alter table %I disable row level security', t);
    end if;
  end loop;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cip_app') then
    alter default privileges in schema public revoke all on tables from cip_app;
    revoke all on all tables in schema public from cip_app;
    revoke all on schema public from cip_app;
    -- anything cip_app came to own, so DROP ROLE has nothing left to complain about
    drop owned by cip_app;
    drop role cip_app;
  end if;
end
$$;

drop function if exists cip_current_company();
