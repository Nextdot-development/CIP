-- What a video check looked at and listened to.
--
-- A video is checked from one frame per shot and from its soundtrack in words.
-- Both are kept beside the verdict. A reviewer reading "nothing wrong" needs to
-- know it was judged on eleven frames from nine shots, and what CIP took the
-- voiceover to say: a transcription that misheard the disclaimer is a verdict
-- resting on words nobody said, and the only defence is being able to read them.
--
-- heard_status keeps "nothing was said" apart from "it could not be heard".
-- They look the same as an empty transcript and mean opposite things.
alter table creative_checks
  add column if not exists video_seconds real,
  add column if not exists video_shots integer,
  add column if not exists video_frames real[],
  add column if not exists video_complete boolean,
  add column if not exists heard text,
  add column if not exists heard_status text
    check (heard_status in ('heard', 'nothing_said', 'no_audio', 'failed'));
