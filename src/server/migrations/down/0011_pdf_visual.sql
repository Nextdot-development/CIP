-- Undo 0011. Children first: pdf_post carries a composite foreign key to
-- pdf_page_understanding, so dropping the page table first would fail.
--
-- The rendered page images in the bucket are not removed here. A migration
-- cannot reach storage, and deleting a company's bytes as a side effect of a
-- schema rollback would be the wrong thing to do quietly — storage:gc collects
-- them once nothing references them.
drop table if exists pdf_post;
drop table if exists pdf_page_understanding;

alter table brand_dna_evidence drop column if exists source_type;
alter table brand_dna_evidence drop column if exists page_number;

-- Back to the three kinds 0010 knew about. Any pdf_visual row would violate
-- this, so those are returned to 'document' first — the file is still there
-- and re-running 0011 will understand it again.
update asset_understanding set kind = 'document' where kind = 'pdf_visual';
alter table asset_understanding drop constraint if exists asset_understanding_kind_check;
alter table asset_understanding add constraint asset_understanding_kind_check
  check (kind in ('image', 'video', 'document'));
