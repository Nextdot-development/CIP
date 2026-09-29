-- Undo 0041. Every connection is read as a signed-in person again.
alter table google_drive_connections
  drop column if exists auth_kind;
