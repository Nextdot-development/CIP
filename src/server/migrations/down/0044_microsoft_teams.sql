-- Undo 0044.
--
-- The source_type constraint goes back to what 0023 left, which means any
-- drive_files row still labelled 'microsoft_teams' would fail the check. Those
-- rows are the synced files themselves, so they go first — and with them, by
-- cascade, the bookkeeping that points at them.
delete from drive_files where source_type = 'microsoft_teams';

drop table if exists microsoft_files;
drop table if exists microsoft_connections;

alter table drive_files
  drop constraint if exists drive_files_source_type_check;

alter table drive_files
  add constraint drive_files_source_type_check
  check (source_type in ('cip_drive', 'google_drive', 'website'));
