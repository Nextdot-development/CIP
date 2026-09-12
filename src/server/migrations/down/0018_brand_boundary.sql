-- Undo 0018. Briefs go back to being built from every brand's material at
-- once; nothing is lost but the boundary between them.
drop index if exists drive_files_brand_idx;
drop index if exists brain_lessons_brand_idx;

-- The identity index loses the brand, so two brands holding the same lesson
-- merge back into one. The older row survives.
drop index if exists brain_lessons_identity_idx;
delete from brain_lessons a
 using brain_lessons b
 where a.company_id = b.company_id
   and a.polarity = b.polarity
   and a.statement = b.statement
   and coalesce(a.task_type, '') = coalesce(b.task_type, '')
   and coalesce(a.platform,  '') = coalesce(b.platform,  '')
   and coalesce(a.campaign,  '') = coalesce(b.campaign,  '')
   and coalesce(a.product,   '') = coalesce(b.product,   '')
   and a.id > b.id;

create unique index brain_lessons_identity_idx on brain_lessons (
  company_id, polarity, statement,
  coalesce(task_type, ''), coalesce(platform, ''),
  coalesce(campaign, ''), coalesce(product, '')
);

alter table drive_files  drop column if exists brand;
alter table brain_lessons drop column if exists brand;
