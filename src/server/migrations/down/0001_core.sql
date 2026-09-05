-- Undo 0001. The pgcrypto extension is left in place: other things may use it,
-- and dropping an extension someone else installed is not ours to do.
drop table if exists sessions;
drop table if exists memberships;
drop table if exists users;
drop table if exists company_branding;
drop table if exists companies;
