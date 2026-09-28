-- Undo 0036. Checks and flags stay; what is lost is the text read off each
-- frame, the record of the second look, and which moments a flag was about.
alter table check_flags
  drop column if exists at_seconds;

alter table creative_checks
  drop column if exists video_text,
  drop column if exists second_look;
