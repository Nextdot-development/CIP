-- Undo 0042. Each flag names one rule again.
alter table check_flags
  drop column if exists also_rule_ids;
