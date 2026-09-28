-- A video's small print, and a second look at what its check found.
--
-- video_text is what was read off each frame at full size, one entry per frame
-- in the order of video_frames. On the sheet a statutory warning is a smudge;
-- read off the frame it is a line of text, and a reviewer can see what CIP
-- took it to say.
--
-- second_look is what the closer look at the findings decided: how many it
-- looked at, how many it could not settle, and each one it threw out with the
-- reason. A dropped flag is kept here so a reviewer can disagree with it.
--
-- at_seconds says which moments of a video a flag is about, so a reviewer can
-- go straight to them. Empty for a flag about the whole film.
alter table creative_checks
  add column if not exists video_text text[],
  add column if not exists second_look jsonb;

alter table check_flags
  add column if not exists at_seconds real[] not null default '{}';
