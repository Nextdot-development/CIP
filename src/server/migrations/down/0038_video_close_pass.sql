-- Undo 0038. The checks stay; what is lost is the record of the close pass.
alter table creative_checks
  drop column if exists close_pass;
