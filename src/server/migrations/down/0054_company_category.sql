-- Undo 0054. Every workspace is read as the spirits company CIP was built for.
alter table companies drop column if exists logo_corner;
alter table companies drop column if exists category;
