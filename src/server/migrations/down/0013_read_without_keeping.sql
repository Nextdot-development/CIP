-- Undo 0013. Files that were read without being kept have no bytes to point
-- at, so they cannot exist under the old shape: they are archived rather than
-- deleted, and what was learned from them survives in asset_understanding.
update drive_files set archived_at = now() where not bytes_retained and archived_at is null;
delete from drive_files where not bytes_retained;

alter table drive_files drop constraint if exists drive_files_retained_has_path;
drop index if exists drive_files_unretained_idx;
alter table drive_files drop column if exists bytes_retained;
alter table drive_files alter column storage_path set not null;
