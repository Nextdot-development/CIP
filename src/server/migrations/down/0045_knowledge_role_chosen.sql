-- Undo 0045. Roles stay as they are; whether a person chose them is forgotten.
alter table drive_files
  drop column if exists knowledge_role_chosen;
