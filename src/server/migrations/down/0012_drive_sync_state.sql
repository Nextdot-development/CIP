-- Undo 0012. Rows judged too large become plain failures again, because the
-- older constraint has no word for them.
update google_drive_files set state = 'failed' where state = 'too_large';

alter table google_drive_files drop column if exists limit_bytes;

alter table google_drive_files drop constraint if exists google_drive_files_state_check;
alter table google_drive_files add constraint google_drive_files_state_check
  check (state in ('pending', 'synced', 'unsupported', 'trashed', 'failed'));
