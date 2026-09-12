-- ===========================================================================
-- 0023 — a brand's own website as a source
--
-- Radico publishes a page per brand: Rampur's expressions, Jaisalmer's
-- botanicals, what Kohinoor is aged in, the ABV of every 8PM variant. CIP knew
-- none of it, because it had only ever been shown pictures.
--
-- That gap is not evenly spread. The brands with the fewest facts are exactly
-- the ones with the fewest photographs - Sangam and Kohinoor Reserve hold
-- fourteen facts each and no content facts at all - and every one of them has
-- a website saying what it is.
--
-- A page becomes a file. Not a new table, not a second pipeline: the same
-- drive_files row every upload and every synced document already uses, with
-- source_type saying where it came from. Everything downstream then works
-- unchanged - it is extracted, understood, turned into facts, attributed to a
-- brand, bounded by the brand boundary and counted as evidence like anything
-- else. A second pipeline would have needed all of that written twice.
--
-- The source stays visible because that is the whole reason to record it. A
-- brand's own site is authoritative about what a product is - its strength,
-- its cask, its category - and says nothing about how a campaign should look.
-- Somebody reading a brief needs to be able to tell which of the two they are
-- being told.
-- ===========================================================================

alter table drive_files
  drop constraint if exists drive_files_source_type_check;

alter table drive_files
  add constraint drive_files_source_type_check
  check (source_type in ('cip_drive', 'google_drive', 'website'));

comment on column drive_files.source_type is
  'Where this came from. website = a page fetched from the brand''s own site, authoritative about the product and silent about the design.';
