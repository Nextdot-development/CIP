-- Undo 0023. Pages fetched from the web are archived rather than deleted, so
-- the facts they evidenced keep pointing at something real.
update drive_files set archived_at = now() where source_type = 'website' and archived_at is null;
update drive_files set source_type = 'cip_drive' where source_type = 'website';

alter table drive_files
  drop constraint if exists drive_files_source_type_check;

alter table drive_files
  add constraint drive_files_source_type_check
  check (source_type in ('cip_drive', 'google_drive'));
