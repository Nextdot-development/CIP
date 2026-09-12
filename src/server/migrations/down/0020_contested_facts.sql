-- Undo 0020. Everything CIP had set aside becomes something it will say again,
-- including the pairs that contradict each other.
drop index if exists brand_dna_facts_contested_idx;

update brand_dna_facts set status = 'active'
 where status in ('superseded', 'contested');

alter table brand_dna_facts
  drop constraint if exists brand_dna_facts_status_check;

alter table brand_dna_facts
  add constraint brand_dna_facts_status_check
  check (status in ('active', 'superseded', 'rejected'));
