-- Undo 0051. GitHub's half-hourly pass and Vercel's daily one remain.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'cip-pump';
  end if;
end
$$;
drop table if exists pump_runs;
drop table if exists cip_runtime;
