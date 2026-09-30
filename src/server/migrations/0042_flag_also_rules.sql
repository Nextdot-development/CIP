-- The other rules one flag breaks.
--
-- One fault can break more than one rule: a logo in the wrong corner breaks
-- the brand's own logo rule and the company-wide one. Reported as a flag per
-- rule it read as two faults - "Whytehall logo is centred" and "Move brand
-- logo to top-right" - on the same frames. A flag now names its closest rule
-- in rule_id and the rest here, and is reported once.
alter table check_flags
  add column if not exists also_rule_ids uuid[] not null default '{}';
