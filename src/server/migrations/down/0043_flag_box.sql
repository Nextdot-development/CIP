-- Undo 0043. Flags show their pictures without marking where.
alter table check_flags
  drop column if exists box;
