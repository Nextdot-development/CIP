-- ===========================================================================
-- 0028 — what a file is for
--
-- Every file used to be read as brand material: looked at, and turned into
-- Brand DNA - what the brand looks like, how it sounds. That is right for a
-- brand's own posts and guidelines and wrong for everything else a team keeps.
-- A competitor's annual report read that way teaches Radico to sound like
-- Diageo's investor relations department; a marketing book teaches it Coca-
-- Cola's colours.
--
-- knowledge_role says which kind of knowledge a file is:
--   brand      read into Brand DNA (the default, and everything before this)
--   market     read into market signals, and searchable - never Brand DNA
--   reference  background reading: searchable and citable - neither of the above
-- ===========================================================================

alter table drive_files
  add column knowledge_role text not null default 'brand'
    check (knowledge_role in ('brand', 'market', 'reference'));

-- A file already registered as market data is market data.
update drive_files f
   set knowledge_role = 'market'
 where exists (
   select 1 from market_sources m
    where m.company_id = f.company_id and m.file_id = f.id
 );
