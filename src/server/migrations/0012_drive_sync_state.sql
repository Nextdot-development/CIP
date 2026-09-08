-- ===========================================================================
-- 0012 — telling "too large" apart from "failed"
--
-- India.pdf and nigeria.pdf are 52.84 MB against a 50 MB cap, and both were
-- recorded as `failed` with a sentence about it. That is three different
-- things wearing one label: a file Google would not give us, a file we chose
-- not to accept, and a file that broke on the way in. Only the middle one is
-- fixed by changing a number, and only the middle one should say so.
--
-- `too_large` is that middle case. The measured size is already on the row as
-- external_size, so the limit that rejected it is what gets recorded here —
-- a row that says 55,400,000 against 52,428,800 explains itself a year later,
-- when whatever the limit is today has been forgotten.
-- ===========================================================================

alter table google_drive_files drop constraint if exists google_drive_files_state_check;
alter table google_drive_files add constraint google_drive_files_state_check
  check (state in ('pending', 'synced', 'unsupported', 'trashed', 'failed', 'too_large'));

-- The ceiling in force when this row was last judged. Null for every other
-- state: it is only meaningful next to a size that exceeded it.
alter table google_drive_files add column if not exists limit_bytes bigint;
