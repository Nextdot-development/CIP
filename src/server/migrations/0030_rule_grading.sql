-- Rules that can say how serious they are, and what kind of rule they are.
--
-- compliance_rules began as what a regulator requires: a thing is either
-- required or forbidden, and breaking it is breaking it. That is true of a
-- statutory warning and false of almost everything a brand team argues about.
--
-- Radico's own QC document makes the distinction plainly. "Bee imagery must not
-- be used" on 8PM Honey is PROHIBITED and MAJOR. "Tiger imagery is an approved
-- brand association" is ALLOWED and INFORMATIONAL - it is not a requirement at
-- all, it exists so the checker does not flag a tiger as stray wildlife. Stored
-- in the old shape, both become "forbidden", and the second one starts failing
-- creatives for doing the right thing.
--
-- So a rule now carries its own kind and its own severity, and the checker
-- takes both from the rule rather than from whatever the model felt. A model
-- that decides how serious its own finding is has graded its own homework.

alter table compliance_rules
  -- The document's own identifier - RADICO-GLOBAL-001, 8PM_HONEY_VIS_001 - so a
  -- rule on screen can be traced back to the page it was written on.
  add column if not exists rule_code text,

  add column if not exists rule_type text not null default 'mandatory'
    check (rule_type in ('mandatory', 'prohibited', 'preferred', 'allowed',
                         'conditional', 'contextual', 'human_review')),

  add column if not exists severity text not null default 'major'
    check (severity in ('critical', 'major', 'minor', 'informational')),

  -- Logo, Visual, Copy, Market, Alcohol Compliance, and the rest of the
  -- document's domain tags. Free text: the list grows, and a check constraint
  -- that has to be migrated every time somebody adds "Packaging" is a tax.
  add column if not exists domain text,

  -- Narrower than a brand. "8PM Honey" has rules "8PM" does not.
  add column if not exists product text,

  -- Why the rule exists, in its author's words, so a flag can explain itself
  -- rather than only assert.
  add column if not exists rationale text,

  -- Things the rule explicitly permits, and things it explicitly forbids. Held
  -- apart because the boundary is the rule: honey and honeycomb are allowed on
  -- 8PM Honey and bees are not, and a checker that has only the prohibition
  -- will eventually flag the honey.
  add column if not exists allowed text[] not null default '{}',
  add column if not exists prohibited text[] not null default '{}',

  -- The rule's author does not trust a machine to decide this one alone.
  add column if not exists human_review boolean not null default false;

-- A rule code is unique within a company, so loading the same document twice
-- updates rules rather than duplicating them.
create unique index if not exists compliance_rules_code_idx
  on compliance_rules (company_id, rule_code) where rule_code is not null;

create index if not exists compliance_rules_product_idx
  on compliance_rules (company_id, product) where product is not null;

-- Existing rules keep behaving exactly as they did: everything already stored
-- was written as a hard requirement, and that is what 'mandatory'/'prohibited'
-- with 'major' severity means.
update compliance_rules
   set rule_type = case when requirement = 'forbidden' then 'prohibited' else 'mandatory' end
 where rule_code is null;
