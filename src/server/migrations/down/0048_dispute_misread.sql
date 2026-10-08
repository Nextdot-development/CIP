-- Undo 0048. A misread is filed as an exception, the nearest of the two.
update check_flags set dispute_reason = 'exception' where dispute_reason = 'misread';
alter table check_flags drop constraint if exists check_flags_dispute_reason_check;
alter table check_flags
  add constraint check_flags_dispute_reason_check
  check (dispute_reason in ('exception', 'wrong_rule'));
