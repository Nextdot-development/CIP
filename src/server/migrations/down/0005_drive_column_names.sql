-- Undo 0005.
alter table drive_files rename constraint drive_files_storage_path_key
  to drive_files_storage_key_key;

alter table drive_files rename column original_filename to original_name;
alter table drive_files rename column file_type         to extension;
alter table drive_files rename column file_size         to size_bytes;
alter table drive_files rename column storage_path      to storage_key;
alter table drive_files rename column uploaded_by       to created_by;
