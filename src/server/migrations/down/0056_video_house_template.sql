-- Undo 0056.
alter table video_edits drop column if exists given_plan;
alter table video_edits drop column if exists hospital_line;
alter table video_templates drop column if exists tagline;
alter table video_templates drop column if exists end_video_vertical_file_id;
alter table video_templates drop column if exists end_video_file_id;
alter table video_templates drop column if exists logo_corner;
