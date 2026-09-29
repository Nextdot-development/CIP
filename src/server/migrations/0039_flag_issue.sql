-- Whether a flag is something to add or something to change.
--
-- "No 'Drink Responsibly' line" and "the logo is bottom-right" need different
-- things from a reviewer: the first is one more line on a list of what the
-- end card must carry, the second is a moment in the film to go and change.
-- The report lists them apart. Null on flags from before the checker said;
-- those are read from their words.
alter table check_flags
  add column if not exists issue text check (issue in ('missing', 'wrong'));
