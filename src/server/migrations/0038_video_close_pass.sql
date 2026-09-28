-- The search of a video's frames at full size for anything a rule forbids.
--
-- The sheet a video is judged from shows each frame a few hundred pixels wide,
-- and a competitor's bottle on a back shelf is lost at that size. Every frame
-- is now searched close up as well, and what that pass did - how many frames,
-- how many findings, or that it failed - is kept beside the verdict, so a
-- clean result says whether it rests on thumbnails alone.
alter table creative_checks
  add column if not exists close_pass jsonb;
