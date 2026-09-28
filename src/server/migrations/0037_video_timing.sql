-- When a video's text is on screen, and what language it was heard in.
--
-- video_timeline is each line of on-screen text with the stretches of the film
-- it is up for, read every second or so. It is only measured when a rule turns
-- on on-screen text or how long it is shown: "the warning must stay up
-- throughout" cannot be judged from one frame per shot.
--
-- heard_language is the language the soundtrack was heard as, so a reviewer
-- can tell a Hindi voiceover transcribed as Hindi from one guessed at as
-- English.
alter table creative_checks
  add column if not exists video_timeline jsonb,
  add column if not exists heard_language text;
