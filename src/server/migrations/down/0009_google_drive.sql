-- Undo 0009. Synced files go first: they carry composite foreign keys back to
-- both the connection and drive_files.
--
-- drive_files rows that came from Google are left alone. They are knowledge the
-- company holds, and dropping the integration is not a reason to destroy it —
-- the source_type column going away simply makes them look like uploads again.
drop table if exists google_drive_files;
drop table if exists google_drive_connections;

drop index if exists drive_files_source_idx;

alter table drive_files drop column if exists source_type;
