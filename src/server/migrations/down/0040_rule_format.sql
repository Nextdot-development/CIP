-- Undo 0040. Every rule applies to every creative again.
alter table compliance_rules
  drop column if exists format;
