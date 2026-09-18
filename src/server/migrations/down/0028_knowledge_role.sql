-- Undo 0028. Every file goes back to being read as brand material.
alter table drive_files drop column if exists knowledge_role;
