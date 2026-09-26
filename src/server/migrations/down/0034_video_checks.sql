-- Undo 0034. The checks and their verdicts stay; what is lost is the record
-- of which frames a video was judged on and what its soundtrack was taken to say.
alter table creative_checks
  drop column if exists video_seconds,
  drop column if exists video_shots,
  drop column if exists video_frames,
  drop column if exists video_complete,
  drop column if exists heard,
  drop column if exists heard_status;
