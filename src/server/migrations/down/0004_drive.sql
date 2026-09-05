-- Undo 0004. Dropping the tables takes their policies, indexes and the
-- composite foreign keys with them.
drop table if exists drive_files;
drop table if exists drive_folders;
drop function if exists cip_drive_folder_no_cycle();
