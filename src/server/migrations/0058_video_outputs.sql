-- More from one recording: a vertical Short alongside a horizontal film, the
-- captions as an .srt for YouTube, the thumbnail in the house layout, and a
-- quick low-resolution preview made before the film itself.
alter table video_edits
  add column if not exists make_vertical boolean not null default false,
  add column if not exists output_vertical_path text,
  add column if not exists captions text,
  add column if not exists thumbnail_path text,
  add column if not exists preview_path text;
