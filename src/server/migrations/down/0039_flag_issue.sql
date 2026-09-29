-- Undo 0039. The flags stay; whether each was to add or to change is read
-- from its words again.
alter table check_flags
  drop column if exists issue;
