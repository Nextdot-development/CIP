-- The pump, on a clock that keeps time, and a record of every pass.
--
-- GitHub's schedule was "every thirty minutes" in name and irregular in fact,
-- and once nothing ran for days without anybody knowing. Supabase runs the
-- schedule now, from inside the database, every fifteen minutes - GitHub and
-- Vercel's daily cron stay on as a backup. Every pass is recorded, so a pump
-- that has stopped shows on the health card the same day.
--
--   cip_runtime   settings the deployment itself writes: where it lives, and
--                 the token the database's scheduler calls it with. Never
--                 readable by the app's own role.
--   pump_runs     one row a pass: when, called by what, and what it did

create table if not exists cip_runtime (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
revoke all on cip_runtime from public;

-- Made here, in the database, from its own randomness: the token is in no
-- file, no repository and no environment variable.
insert into cip_runtime (key, value)
values ('pump_token', encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex'))
on conflict (key) do nothing;

create table if not exists pump_runs (
  id          uuid primary key default gen_random_uuid(),
  trigger     text not null check (trigger in ('scheduler', 'github', 'vercel', 'manual')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  tally       jsonb,
  error       text
);
create index if not exists pump_runs_started_idx on pump_runs (started_at desc);
revoke all on pump_runs from public;

-- The schedule itself, where the database can keep one. A database without
-- pg_cron and pg_net - the one the tests run on - simply has no schedule.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    begin
      create extension if not exists pg_net;
      create extension if not exists pg_cron;
      perform cron.unschedule(jobid) from cron.job where jobname = 'cip-pump';
      -- Calls nothing until the deployment has said where it lives: the
      -- first pass GitHub or Vercel runs records it.
      perform cron.schedule(
        'cip-pump',
        '*/15 * * * *',
        $job$
          select net.http_get(
                   url := u.value || '/api/cron/pump',
                   headers := jsonb_build_object('authorization', 'Bearer ' || t.value, 'x-cip-trigger', 'scheduler'),
                   timeout_milliseconds := 300000)
            from public.cip_runtime u, public.cip_runtime t
           where u.key = 'pump_url' and t.key = 'pump_token'
        $job$
      );
    exception when others then
      raise notice 'The pump could not be scheduled in this database: %', sqlerrm;
    end;
  end if;
end
$$;
