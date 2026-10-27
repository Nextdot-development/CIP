-- Undo 0060. Every fact tidied away is said again, in its own words.
update brand_dna_facts set status = 'active'
 where status in ('merged', 'set_aside');

alter table brand_dna_facts drop column if exists merged_into;

alter table brand_dna_facts
  drop constraint if exists brand_dna_facts_status_check;

alter table brand_dna_facts
  add constraint brand_dna_facts_status_check
  check (status in ('active', 'superseded', 'contested', 'rejected'));
