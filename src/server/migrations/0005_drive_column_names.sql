-- ===========================================================================
-- 0005 — settle the drive_files column names
--
-- Renames only. No data moves, no types change, and every constraint and index
-- follows its column automatically, so this is safe to run against a populated
-- table and safe to reverse.
--
--   original_name  -> original_filename
--   extension      -> file_type
--   size_bytes     -> file_size
--   storage_key    -> storage_path
--   created_by     -> uploaded_by     (it always meant "who uploaded this")
-- ===========================================================================

alter table drive_files rename column original_name to original_filename;
alter table drive_files rename column extension     to file_type;
alter table drive_files rename column size_bytes    to file_size;
alter table drive_files rename column storage_key   to storage_path;
alter table drive_files rename column created_by    to uploaded_by;

-- The unique constraint keeps its old auto-generated name otherwise, which
-- would be a confusing thing to meet in an error message.
alter table drive_files rename constraint drive_files_storage_key_key
  to drive_files_storage_path_key;
