-- The video editor, made to Narayana Health's own template.
--
-- "Video Template NH 2026": open on the doctor, the logo in one corner (or
-- only at the end of a vertical film), the doctor's name plate with the
-- hospital line, the disclaimer as a band after the introduction, the
-- on-screen text as a split screen, and the hospital's own end screens.
-- A plan can now also be supplied by a person rather than written by CIP.

alter table video_templates
  add column if not exists logo_corner text not null default 'top-right'
    check (logo_corner in ('top-left', 'top-right')),
  -- The hospital's own end screens, one per shape. Drawn by CIP when unset.
  add column if not exists end_video_file_id uuid references drive_files(id) on delete set null,
  add column if not exists end_video_vertical_file_id uuid references drive_files(id) on delete set null,
  add column if not exists tagline text;

alter table video_edits
  -- "Narayana Health City | Bommasandra": the line under the doctor's name.
  add column if not exists hospital_line text,
  -- The plan a person supplied, as they wrote it.
  add column if not exists given_plan text;
