-- Undo 0006. Dropping the tables takes their policies, indexes and composite
-- foreign keys with them.
drop table if exists drive_file_chunks;
drop table if exists drive_file_extractions;

drop index if exists drive_files_queue_idx;

alter table drive_files
  drop column if exists processing_started_at,
  drop column if exists next_attempt_at;
