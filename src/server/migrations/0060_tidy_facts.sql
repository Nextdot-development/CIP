-- ===========================================================================
-- 0060 — one way of saying each fact
--
-- The same observation reached Brand DNA under many spellings - "colour
-- palette", "colourPalette", "colours"; "top-right" and "top-right corner" -
-- and each spelling counted its evidence alone. And a good deal of it was
-- never about a brand: a letter's salutation, a revenue chart's axis, the
-- white of a white background read as a brand colour.
--
-- Facts are now said one way, and two statuses record what that did to the
-- ones already on record. Neither deletes anything, and neither is undone by
-- the contradiction resolver, which only restores what it set aside itself.
--
--   merged     the same claim as another fact, said differently. Its evidence
--              now also stands behind merged_into, which is what CIP says.
--   set_aside  not knowledge about a brand at all.
-- ===========================================================================

alter table brand_dna_facts
  drop constraint if exists brand_dna_facts_status_check;

alter table brand_dna_facts
  add constraint brand_dna_facts_status_check
  check (status in ('active', 'superseded', 'contested', 'rejected', 'merged', 'set_aside'));

alter table brand_dna_facts add column if not exists merged_into uuid;

comment on column brand_dna_facts.status is 'active = CIP will say it. superseded = a better-evidenced claim replaced it. contested = two claims that cannot both be true, evenly supported. rejected = a person said no, and nothing automatic ever changes it. merged = the same claim as merged_into, said differently. set_aside = not knowledge about a brand.';
comment on column brand_dna_facts.merged_into is 'For a merged fact, the fact that now carries its evidence.';
