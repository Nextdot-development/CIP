-- A third way to disagree with a flag: CIP misread the creative.
--
-- "This creative is an exception" and "the rule is wrong" were the only two
-- answers, and the commonest real one is neither: the rule is right, the
-- creative follows it, and the checker saw it wrong - a centred logo called
-- off-centre. Recorded as itself, it is shown to the checker beside the rule
-- next time, and it retires nothing.
alter table check_flags drop constraint if exists check_flags_dispute_reason_check;
alter table check_flags
  add constraint check_flags_dispute_reason_check
  check (dispute_reason in ('exception', 'wrong_rule', 'misread'));
