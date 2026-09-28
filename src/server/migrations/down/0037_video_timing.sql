-- Undo 0037. The checks stay; what is lost is when each line of text was on
-- screen and the language the soundtrack was heard in.
alter table creative_checks
  drop column if exists video_timeline,
  drop column if exists heard_language;
