-- ===========================================================================
-- 0020 — letting the Brain disagree with itself
--
-- brand_dna_facts has carried 'superseded' and 'rejected' in its status check
-- since 0010, and nothing has ever set either. Every fact CIP has ever learned
-- is 'active'. A claim read once off a blurry photograph stands beside one
-- seen across forty assets, and both go into the same brief.
--
-- Which means CIP can hold two facts that cannot both be true — a cap that is
-- gold and a cap that is black — and hand a generator both at once. That is
-- not a model problem. It is knowledge nobody ever revisited.
--
-- So facts are now re-judged against each other on every recompute, and a
-- third outcome is needed that the original three do not cover.
--
--   active      what CIP will say.
--   superseded  a claim a better-evidenced one replaced. Automatic, and
--               reversible: if the winner loses its evidence, this comes back.
--   contested   two claims that cannot both be true and are evenly supported.
--               Not a winner and a loser — a thing CIP does not know.
--   rejected    a person said no. Never touched by anything automatic.
--
-- The distinction between superseded and contested is the whole point. Voting
-- resolves a disagreement only when there is something to count; forty assets
-- against one is evidence, three against two is not. Calling the second one
-- settled would be how a confident wrong answer gets made.
--
-- Contested facts are excluded from briefs by the same filter that already
-- excludes superseded ones, so a disagreement stops reaching the generator the
-- moment it is detected — and stays visible, because what CIP cannot decide is
-- worth showing a person.
-- ===========================================================================

alter table brand_dna_facts
  drop constraint if exists brand_dna_facts_status_check;

alter table brand_dna_facts
  add constraint brand_dna_facts_status_check
  check (status in ('active', 'superseded', 'contested', 'rejected'));

comment on column brand_dna_facts.status is
  'active = CIP will say it. superseded = a better-evidenced claim replaced it. '
  'contested = two claims that cannot both be true, evenly supported. '
  'rejected = a person said no; nothing automatic ever changes this.';

-- Finding the facts that disagree, per brand and attribute, is what the
-- resolver does on every pass and what the Trust page reads back.
create index if not exists brand_dna_facts_contested_idx
  on brand_dna_facts (company_id, status)
  where status = 'contested';
