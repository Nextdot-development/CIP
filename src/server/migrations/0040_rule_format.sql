-- Which kind of creative a rule is for: every kind, pictures only, or video only.
--
-- Radico's QC document scopes each rule by format ("format": "ALL") and lists,
-- in section 4.3, what is judged on a video and on nothing else - the
-- voiceover, subtitles, music, transitions, continuity from shot to shot, the
-- end screen. Sent to the checker for a banner, "subtitles must match the
-- voiceover" is a rule a picture can only fail by misreading, so a rule now
-- says which creatives it is for, and only those are judged against it.
alter table compliance_rules
  add column if not exists format text not null default 'all'
    check (format in ('all', 'image', 'video'));
