-- Undo 0058.
alter table video_edits
  drop column if exists preview_path,
  drop column if exists thumbnail_path,
  drop column if exists captions,
  drop column if exists output_vertical_path,
  drop column if exists make_vertical;
