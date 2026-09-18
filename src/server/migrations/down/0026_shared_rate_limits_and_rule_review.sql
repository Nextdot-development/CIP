-- Undo 0026. Limits go back to counting per process, and every rule forgets
-- that anyone verified it.
alter table compliance_rules
  drop column if exists verified_at,
  drop column if exists verified_by;

drop table if exists rate_limit_buckets;
