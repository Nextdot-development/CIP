-- Where on the picture a flag's fault is.
--
-- A flag showed the whole frame and left the reviewer to find the logo, the
-- bottle on the back shelf, the misspelt word. It now keeps a rectangle -
-- fractions of the picture from its top-left, and for a video which frame -
-- drawn over the picture on the report and on paper. Null for something
-- missing, which has no place to point at.
alter table check_flags
  add column if not exists box jsonb;
