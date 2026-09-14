-- ===========================================================================
-- 0024 — checking a creative against the brand before it goes live
--
-- CIP could make a picture and could not look at one and say whether it was
-- right. The Consistency & Compliance Checker is that: a new creative, scored
-- against what CIP knows about the brand and against the rules the category
-- has to obey, with every flag saying which rule it came from.
--
-- Three tables.
--
-- compliance_rules are stated, not observed. Brand DNA facts accumulate from
-- assets - forty packshots with the logo top-left become one fact with forty
-- pieces of evidence. A rule like "carry Drink Responsibly" never accumulates
-- from anything: it comes from a regulator or from the client, and it is true
-- on the first day or not at all. So it lives on its own, with the brand and
-- the market it applies to, and where it came from. CIP held not a single one
-- of these before this migration, which for an alcohol portfolio meant the
-- compliance third of any check had nothing to check against.
--
-- creative_checks record one review of one asset: the scores, and - so a
-- number can be read honestly - how many facts and rules it was judged
-- against. A hundred out of a hundred against no rules is not a pass.
--
-- check_flags are the findings, and the place a person disagrees. A dispute
-- says which of two things is wrong: this asset is a legitimate exception, or
-- the rule itself was learned wrong. Only the second changes what CIP
-- believes, and only because a person said so.
--
-- A flag keeps the id of the fact or rule it cited without a foreign key. A
-- check is a historical record; the fact it cited may later be retired or
-- removed, and the flag has to survive that to still say what was judged.
-- ===========================================================================

create table compliance_rules (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,

  -- Null means every brand, and every market. Most category rules are the
  -- first; most regulatory rules are the second's opposite.
  brand  text,
  market text,

  category text not null default 'other'
    check (category in ('disclaimer', 'audience', 'claim', 'placement', 'medium', 'other')),
  requirement text not null
    check (requirement in ('required', 'forbidden')),

  -- The rule in plain language, as the checker applies it and as a reviewer
  -- reads it back.
  rule text not null,
  -- Why the rule exists, so a flag can explain itself.
  note text,
  -- Where a regulatory rule comes from. Kept so it can be re-checked: the
  -- rules change, and a rule nobody can trace is a rule nobody can update.
  reference_url text,

  source text not null default 'manual'
    check (source in ('manual', 'regulation', 'suggested')),
  active boolean not null default true,

  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id)
);

-- The same rule for the same brand and market once. A table constraint cannot
-- hold an expression and brand and market are nullable, so the uniqueness goes
-- over a normalised form, as it does for facts, lessons and the calendar.
create unique index compliance_rules_identity_idx
  on compliance_rules (company_id, rule, coalesce(brand, ''), coalesce(market, ''));

create index compliance_rules_lookup_idx
  on compliance_rules (company_id, active, market, brand);

create table creative_checks (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,

  -- What was checked: an uploaded asset, or something CIP generated. A
  -- generated image is checked by the same checker as a human one - there is
  -- no separate, untested path for the model's own output.
  file_id       uuid,
  generation_id uuid,

  brand  text,
  market text,

  status text not null default 'pending'
    check (status in ('pending', 'ready', 'failed')),

  -- 0 to 100. Worked out from the flags, not asked of the model: a score the
  -- model reports about its own judgement is a number it chose.
  score            int check (score between 0 and 100),
  visual_score     int check (visual_score between 0 and 100),
  verbal_score     int check (verbal_score between 0 and 100),
  compliance_score int check (compliance_score between 0 and 100),

  summary text,

  -- How much the score stands on. Shown beside it, because a perfect score
  -- against nothing is the most misleading number this table could hold.
  facts_considered int not null default 0,
  rules_considered int not null default 0,

  provider text,
  model    text,
  error_code    text,
  error_message text,

  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  completed_at timestamptz,

  unique (id, company_id),
  check (file_id is not null or generation_id is not null),

  foreign key (file_id, company_id)
    references drive_files (id, company_id) on delete cascade,
  foreign key (generation_id, company_id)
    references media_generations (id, company_id) on delete cascade
);

create index creative_checks_recent_idx on creative_checks (company_id, created_at desc);

create table check_flags (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  check_id   uuid not null,

  dimension text not null check (dimension in ('visual', 'verbal', 'compliance')),
  severity  text not null check (severity in ('critical', 'warning', 'note')),
  message   text not null,

  -- What the flag was judged against. Exactly one is set: a flag that cites
  -- nothing is a flag the model made up, and the checker never stores one.
  fact_id uuid,
  rule_id uuid,

  status text not null default 'open'
    check (status in ('open', 'accepted', 'disputed')),
  -- exception  = the rule is right, this asset may differ.
  -- wrong_rule = the rule itself is wrong for this brand.
  dispute_reason text check (dispute_reason in ('exception', 'wrong_rule')),
  correction text,
  corrected_by uuid references users(id) on delete set null,
  corrected_at timestamptz,

  created_at timestamptz not null default now(),

  unique (id, company_id),
  check ((fact_id is not null) <> (rule_id is not null)),
  check (dispute_reason is null or status = 'disputed'),

  foreign key (check_id, company_id)
    references creative_checks (id, company_id) on delete cascade
);

create index check_flags_check_idx on check_flags (company_id, check_id);

alter table compliance_rules enable row level security;
alter table compliance_rules force  row level security;
create policy cip_company_isolation on compliance_rules
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

alter table creative_checks enable row level security;
alter table creative_checks force  row level security;
create policy cip_company_isolation on creative_checks
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

alter table check_flags enable row level security;
alter table check_flags force  row level security;
create policy cip_company_isolation on check_flags
  using (company_id = cip_current_company()) with check (company_id = cip_current_company());

grant select, insert, update, delete on compliance_rules to cip_app;
grant select, insert, update, delete on creative_checks  to cip_app;
grant select, insert, update, delete on check_flags      to cip_app;
