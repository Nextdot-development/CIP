-- Undo 0046. Filings already fetched stay as ordinary files; what was being
-- watched, and which filings were seen, is forgotten.
drop table if exists market_feed_items;
drop table if exists market_feeds;

update drive_files set source_type = 'website' where source_type = 'exchange_filing';
alter table drive_files
  drop constraint if exists drive_files_source_type_check;
alter table drive_files
  add constraint drive_files_source_type_check
  check (source_type in ('cip_drive', 'google_drive', 'website', 'microsoft_teams'));
